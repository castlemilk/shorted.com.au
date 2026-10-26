package jobmonitor

// alerts_replay.go adds a fourth constrained override-run: replay ONE daily
// report date of the short-interest alert evaluator for ONE owner, as the
// admin smoke test does (docs/alerts-runbook.md "Prod smoke test").
//
// It follows picks.go and publish.go exactly (read their headers first):
//
//  1. IAM: roles/run.developer is granted on exactly ONE job,
//     shorted-alerts-replay (terraform/environments/prod/main.tf). The job is
//     NOT in the fleet-wide run.invoker map.
//  2. The argv is BUILT HERE. The caller supplies a date and nothing else; the
//     owner is the verified token's uid, passed in by the admin tool and never
//     read from tool input. The date must match ^\d{4}-\d{2}-\d{2}$, be a real
//     calendar day and not be after today (UTC). The uid must match a Firebase
//     uid shape. There is no path by which caller text becomes an argv element
//     other than as the value of -date or -user, and only after matching.
//
// Why the job is NOT the VKE CronJob shorted-alerts: a replay must not count as a
// run of the shorted-alerts Telesis monitor, and the cutover guard
// (scripts/tests/vke-jobs-cutover.test.mjs) forbids a Cloud Run twin under that
// name. The Cloud Run job carries the same image; its deployed args are a dry
// run, so a bare execution from the console can never send mail.
//
// The already-running guard applies. A replay writes alert_events rows and sends
// their email; two replays of one date would race on the claim, and a double
// click must not send twice.

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"time"
)

// AlertsReplayJobName is the ONLY job the alerts replay can execute. A constant,
// for the same reason as PicksJobName: the IAM elevation is scoped to this one
// job and the method must not be able to aim elsewhere.
const AlertsReplayJobName = "shorted-alerts-replay"

// alertsSubcommand is the job binary's subcommand (the image ENTRYPOINT is
// /shorted, so args[0] is the subcommand).
const alertsSubcommand = "alerts"

// alertsDatePattern is the shape of a report date the evaluator's -date flag
// accepts. time.Parse then rejects a shape-correct impossible day.
var alertsDatePattern = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)

// alertsUserPattern is the shape of a Firebase uid. It cannot begin with "-", so
// the value after -user can never read as a flag.
var alertsUserPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$`)

// ErrInvalidAlertsDate: the date is not YYYY-MM-DD, not a real day, or in the future.
var ErrInvalidAlertsDate = errors.New("jobmonitor: invalid alerts replay date")

// ErrInvalidAlertsUser: the owner id is not shaped like a Firebase uid.
var ErrInvalidAlertsUser = errors.New("jobmonitor: invalid alerts replay owner")

// AlertsReplayRequest asks for one replay. Note what is NOT here: no job name,
// no region, no arguments, no monitor id, no email.
type AlertsReplayRequest struct {
	// Date is the report date to replay, YYYY-MM-DD.
	Date string
	// UserID is the owner whose monitors the replay evaluates. The admin tool
	// fills it from the verified token only.
	UserID string
	// Actor is the admin identity, for the audit log only.
	Actor string
}

// AlertsReplayRun describes the execution that was created.
type AlertsReplayRun struct {
	Job           string `json:"job"`
	Region        string `json:"region"`
	ExecutionName string `json:"executionName"`
	Date          string `json:"date"`
	// Args is the argv this service constructed. Output, never input.
	Args []string `json:"args"`
}

// NormalizeAlertsReplayDate validates a caller-supplied report date against
// today (UTC). Nothing is trimmed: a date is an identifier, and " 2026-10-01"
// is refused rather than repaired.
func NormalizeAlertsReplayDate(date string, today time.Time) (string, error) {
	if !alertsDatePattern.MatchString(date) {
		return "", fmt.Errorf("%w: want YYYY-MM-DD", ErrInvalidAlertsDate)
	}
	day, err := time.Parse("2006-01-02", date)
	if err != nil {
		return "", fmt.Errorf("%w: %q is not a real calendar day", ErrInvalidAlertsDate, date)
	}
	todayDay := time.Date(today.Year(), today.Month(), today.Day(), 0, 0, 0, 0, time.UTC)
	if day.After(todayDay) {
		return "", fmt.Errorf("%w: %s is in the future", ErrInvalidAlertsDate, date)
	}
	return date, nil
}

// NormalizeAlertsUserID validates the owner id. Case and characters are kept:
// a uid is an identifier, not text to repair.
func NormalizeAlertsUserID(in string) (string, error) {
	if !alertsUserPattern.MatchString(in) {
		return "", ErrInvalidAlertsUser
	}
	return in, nil
}

// alertsReplayArgs builds the argv. Pure and total: given a date and uid that
// passed the normalisers, the result can only be a replay of one owner on one
// day that never moves a watermark (-canary off keeps the proof mail out).
func alertsReplayArgs(date, userID string) []string {
	return []string{alertsSubcommand, "-date", date, "-user", userID, "-canary", "off"}
}

// RunAlertsReplay starts one replay of a daily report date for one owner.
//
// Validation order: date and owner (400) before project config and job
// resolution (404/409) before the running guard (409). Nothing reaches GCP for a
// refused request.
func (c *Collector) RunAlertsReplay(ctx context.Context, req AlertsReplayRequest) (*AlertsReplayRun, error) {
	date, err := NormalizeAlertsReplayDate(req.Date, time.Now().UTC())
	if err != nil {
		return nil, err
	}
	userID, err := NormalizeAlertsUserID(req.UserID)
	if err != nil {
		return nil, err
	}
	target, err := c.resolveNamedTarget(ctx, AlertsReplayJobName)
	if err != nil {
		return nil, err
	}
	if isRunning(target) {
		name := firstNonEmpty(target.RunningExecution, target.ExecutionName)
		started := firstNonEmpty(target.RunningStartedAt, target.LastRunAt)
		return nil, &AlreadyRunningError{
			Job:           target.Name,
			ExecutionName: name,
			StartedAt:     started,
			Age:           ageSince(started, time.Now().UTC()),
		}
	}

	overrider, ok := c.overrideRunner()
	if !ok {
		return nil, ErrOverridesUnsupported
	}
	args := alertsReplayArgs(date, userID)
	execName, err := overrider.RunWithArgs(ctx, c.cfg.ProjectID, target.Region, target.Name, args)
	if err != nil {
		return nil, err
	}
	c.Invalidate()

	return &AlertsReplayRun{
		Job:           target.Name,
		Region:        target.Region,
		ExecutionName: execName,
		Date:          date,
		Args:          args,
	}, nil
}

// AlertsReplayResult polls one replay execution. The execution's state and log
// link are the job's own answer; the per-event outcome is read from the database
// by the caller (alert_events), not from the job.
func (c *Collector) AlertsReplayResult(ctx context.Context, executionName string) (*ExecutionStatus, error) {
	return c.executionStatus(ctx, AlertsReplayJobName, executionName)
}
