package shorts

// mcp_admin_alerts.go: the admin MCP server's alerts tools, behind the mcp
// package's AdminAlertsOperator.
//
// The monitor rules are NOT here. Create, list, status and delete go through
// alertsCore (alerts_core.go), the same code the Connect handlers run, so the
// validation, the Premium rule, the cap and the owner checks cannot differ between
// the web app and this server. What this file adds is the smoke test's own steps:
// find a crossing, make sure the caller has a monitor for it, and replay the date
// for the caller alone.

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	"github.com/castlemilk/shorted.com.au/services/pkg/alertevents"
	"github.com/castlemilk/shorted.com.au/services/shorts/internal/jobmonitor"
	"github.com/castlemilk/shorted.com.au/services/shorts/internal/mcp"
	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
)

// adminAlertsStore is the store the admin alerts tools read and mutate through.
// Reached by a type assertion (alertsAdminStoreFrom), so the shared Store interface
// and its mocks stay as they were.
type adminAlertsStore interface {
	shortsstore.AdminAlertsStore
	alertsMonitorStore
}

// adminAlertsJobs runs and polls the replay job (jobmonitor/alerts_replay.go).
type adminAlertsJobs interface {
	RunAlertsReplay(ctx context.Context, req jobmonitor.AlertsReplayRequest) (*jobmonitor.AlertsReplayRun, error)
	AlertsReplayResult(ctx context.Context, executionName string) (*jobmonitor.ExecutionStatus, error)
}

// alertsAdminStoreFrom narrows the server's store to the admin alerts view. Nil
// when the store does not provide it, which the tools report as unavailable.
func alertsAdminStoreFrom(s ShortsStore) adminAlertsStore {
	a, _ := s.(adminAlertsStore)
	return a
}

// errAdminAlertsEmail is the refusal when the caller's verified address cannot be
// read. The smoke test needs it before anything is created, so the refusal comes
// first and nothing is changed.
var errAdminAlertsEmail = errors.New("this server cannot read your verified address, so nothing was created: the account store is not configured here (INTERNAL_SERVICE_SECRET is unset). The smoke test needs the verified address to create its monitor")

// errAdminAlertsUnavailable is the answer when the alerts store or the job runner
// is not wired on this deployment.
var errAdminAlertsUnavailable = errors.New("the alerts store is not configured in this deployment")

// alertsSmokeNeedsPremium is the refusal for an account the evaluator would skip.
const alertsSmokeNeedsPremium = "this administrator account has no active Premium subscription. The evaluator skips mail to an account " +
	"without one (skipped_unentitled), so the smoke test refuses. Start or grant the subscription, then retry"

// alertsCoreFor returns the shared rule over the admin server's store.
func (a *adminMCPSource) alertsCoreFor() (alertsCore, error) {
	if a.alerts == nil || a.entitled == nil {
		return alertsCore{}, errAdminAlertsUnavailable
	}
	logger := a.logger
	if logger == nil {
		logger = NewLoggerAdapter()
	}
	return alertsCore{store: a.alerts, entitled: a.entitled, logger: logger}, nil
}

// alertsAddressFor returns the caller's VERIFIED address. A nil resolver, or one
// that yields nothing, is refused: an unverified or guessed address is never used.
func (a *adminMCPSource) alertsAddressFor(ctx context.Context, userID string) (string, error) {
	if a.verifiedEmail == nil {
		return "", errAdminAlertsEmail
	}
	email, err := a.verifiedEmail(ctx, userID)
	if err != nil {
		// The reason is the refusal the caller needs: not verified, disabled, not yet
		// deployed, or the account store was unreadable. Nothing was written.
		return "", fmt.Errorf("the verified address could not be read, so nothing was created: %w", err)
	}
	if !strings.Contains(email, "@") {
		return "", errAdminAlertsEmail
	}
	return email, nil
}

// alertsErrorMessageLimit bounds a stored error message shown to an administrator.
const alertsErrorMessageLimit = 200

// truncateAlertText caps text at n runes.
func truncateAlertText(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	r := []rune(s)
	return string(r[:n])
}

// alertsReplayOwnerPattern finds the owner in a run note ("replay D user=<uid>").
var alertsReplayOwnerPattern = regexp.MustCompile(`user=(\S+)`)

// scrubRunNote keeps the caller's own owner id in a run note and replaces any other
// owner's with "one". The evaluator writes the owner of a replay into the note.
func scrubRunNote(note, userID string) string {
	return alertsReplayOwnerPattern.ReplaceAllStringFunc(note, func(m string) string {
		v := strings.TrimPrefix(m, "user=")
		if v == userID || v == "all" || v == "one" {
			return m
		}
		return "user=one"
	})
}

// AlertsStatus reads the alerts pipeline. Each source reads on its own: one that
// fails is named in sources and its section is left empty, never shown as healthy.
// Another owner's event carries no monitor id and no error text: the error text can
// name that owner's subscription status.
func (a *adminMCPSource) AlertsStatus(ctx context.Context, userID string) (*mcp.AlertsStatusOutput, error) {
	out := &mcp.AlertsStatusOutput{
		ObservedAt: time.Now().UTC().Format(time.RFC3339),
		Monitors:   []mcp.AlertMonitorCount{},
		Mine:       []mcp.AlertsOwnMonitor{},
		Runs:       []mcp.AlertsEvaluatorRun{},
		Events:     []mcp.AlertsEvent{},
		Sources:    []mcp.JobSource{},
	}
	core, err := a.alertsCoreFor()
	if err != nil {
		out.Sources = append(out.Sources, mcp.JobSource{Name: "alerts_store", Status: "unconfigured", Detail: err.Error()})
		return out, nil
	}
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()

	if counts, err := a.alerts.AdminAlertMonitorCounts(ctx); err != nil {
		out.Sources = append(out.Sources, mcp.JobSource{Name: "alert_monitor_counts", Status: "unavailable", Detail: "the monitor counts could not be read"})
	} else {
		for _, c := range counts {
			out.Monitors = append(out.Monitors, mcp.AlertMonitorCount{Status: c.Status, Cadence: c.Cadence, Count: c.Count})
		}
		out.Sources = append(out.Sources, mcp.JobSource{Name: "alert_monitor_counts", Status: "available", Detail: "counts across every owner; no owner is named"})
	}

	if h, err := a.alerts.AdminAlertDeliveryHealth(ctx); err != nil {
		out.Sources = append(out.Sources, mcp.JobSource{Name: "alert_delivery_feedback", Status: "unavailable", Detail: "the bounce and complaint counts could not be read"})
	} else {
		out.Delivery = mcp.AlertDeliveryFeedback{Bounced: h.Bounced, Complained: h.Complained, Suppressed: h.Suppressed}
		out.Sources = append(out.Sources, mcp.JobSource{Name: "alert_delivery_feedback", Status: "available", Detail: "counts across every owner; no address is named"})
	}

	mine, total, checked, err := core.listMonitors(ctx, userID, "", 50, 0)
	if err != nil {
		out.Sources = append(out.Sources, mcp.JobSource{Name: "own_monitors", Status: "unavailable", Detail: "the caller's monitors could not be read"})
	} else {
		out.MineTotal = int(total)
		for _, m := range mine {
			row := mcp.AlertsOwnMonitor{
				ID: m.ID, Scope: m.Scope, Target: m.Target, Condition: m.Condition, Threshold: m.Threshold,
				Cadence: m.Cadence, Status: m.Status, HasEmail: m.UserEmail != "", CreatedAt: m.CreatedAt.UTC().Format(time.RFC3339),
			}
			if m.LastEventReportDate != nil {
				row.LastEventReportDate = *m.LastEventReportDate
			}
			if m.LastEventEmailStatus != nil {
				row.LastDeliveryStatus = *m.LastEventEmailStatus
			}
			out.Mine = append(out.Mine, row)
		}
		out.Sources = append(out.Sources, mcp.JobSource{Name: "own_monitors", Status: "available", Detail: "checked through " + checked})
	}

	if runs, err := a.alerts.AdminAlertEvaluatorRuns(ctx, 10); err != nil {
		out.Sources = append(out.Sources, mcp.JobSource{Name: "evaluator_runs", Status: "unavailable", Detail: "the evaluator runs could not be read"})
	} else {
		for _, r := range runs {
			row := mcp.AlertsEvaluatorRun{
				ID: r.ID, StartedAt: r.StartedAt.UTC().Format(time.RFC3339), Outcome: r.Outcome,
				Note: scrubRunNote(r.Note, userID), MonitorsEvaluated: r.MonitorsEvaluated, EventsCreated: r.EventsCreated,
				EmailsSent: r.EmailsSent, EmailsRetrying: r.EmailsRetrying, EmailsFailed: r.EmailsFailed,
				SkippedUnentitled: r.SkippedUnentitled, HasCanaryResendID: r.HasCanaryResendID,
				Error: truncateAlertText(r.Error, alertsErrorMessageLimit),
			}
			if r.FinishedAt != nil {
				row.FinishedAt = r.FinishedAt.UTC().Format(time.RFC3339)
			}
			out.Runs = append(out.Runs, row)
		}
		out.Sources = append(out.Sources, mcp.JobSource{Name: "evaluator_runs", Status: "available", Detail: "the ten newest runs"})
	}

	if events, err := a.alerts.AdminRecentAlertEvents(ctx, 20); err != nil {
		out.Sources = append(out.Sources, mcp.JobSource{Name: "alert_events", Status: "unavailable", Detail: "the alert events could not be read"})
	} else {
		for _, e := range events {
			own := e.UserID == userID
			row := mcp.AlertsEvent{
				ID: e.ID, Own: own, Target: e.Target,
				ReportDate: e.ReportDate, ComparedToDate: e.ComparedToDate,
				LatestPercent: e.LatestPercent, PreviousPercent: e.PreviousPercent,
				EmailStatus: e.EmailStatus, EmailAttempts: e.EmailAttempts, HasResendID: e.HasResendID,
			}
			if own {
				row.MonitorID = e.MonitorID
				row.LastError = truncateAlertText(e.LastError, alertsErrorMessageLimit)
			}
			out.Events = append(out.Events, row)
		}
		out.Sources = append(out.Sources, mcp.JobSource{Name: "alert_events", Status: "available", Detail: "the twenty newest events across owners; monitor ids and error text are the caller's own only"})
	}
	return out, nil
}

// FindAlertCrossing reads the window and applies the evaluator's rule.
func (a *adminMCPSource) FindAlertCrossing(ctx context.Context, in mcp.FindAlertCrossingInput) (*mcp.FindAlertCrossingOutput, error) {
	search, err := mcp.NormaliseAlertsSearch(in.Code, in.Threshold, in.Condition)
	if err != nil {
		return nil, err
	}
	if a.alerts == nil {
		return nil, errAdminAlertsUnavailable
	}
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	w, err := a.alerts.ReportWindow(ctx)
	if err != nil {
		return nil, errors.New("the report window could not be read")
	}
	out := &mcp.FindAlertCrossingOutput{Threshold: search.Threshold, Condition: search.Condition}
	if len(w.Dates) > 0 {
		out.WindowFrom, out.WindowTo = w.Dates[len(w.Dates)-1], w.Dates[0]
	}
	if len(w.Dates) < 2 {
		out.Note = "fewer than two report dates are stored, so there is nothing to compare"
		return out, nil
	}
	c, ok := w.FindShortInterestCrossing(search.Code, search.Threshold)
	if !ok {
		if search.Code != "" {
			out.Note = fmt.Sprintf("%s did not cross %g in the last %d report dates", search.Code, search.Threshold, shortsstore.AlertWindowDates)
		} else {
			out.Note = fmt.Sprintf("no stock whose newest reading is at or above %g crossed it in the last %d report dates", search.Threshold, shortsstore.AlertWindowDates)
		}
		return out, nil
	}
	out.Found = true
	out.Code, out.Name = c.Code, c.Name
	out.ReportDate, out.ComparedToDate, out.PreviousDate = c.ReportDate, c.ComparedTo, c.PreviousDate
	out.Previous, out.Latest = c.Previous, c.Latest
	return out, nil
}

// alsoEmailsNote is the one line every smoke-test result carries: the replay is not
// limited to the smoke monitor.
const alsoEmailsNote = "The replay also emails any other daily monitor of yours that crossed on the same report date. Check alerts_status for them before the mail arrives."

// RunAlertsSmoke is the smoke test's whole path, in the order that refuses cheapest
// first: the caller's uid shape, entitlement, verified address, the crossing, the
// caller's monitor, the existing-event check, and the replay for the caller alone.
// Nothing is replayed unless every step before it passed.
func (a *adminMCPSource) RunAlertsSmoke(ctx context.Context, userID, actor string, in mcp.RunAlertsSmokeInput) (*mcp.RunAlertsSmokeOutput, error) {
	// The owner id is checked before anything can be created under it.
	if _, err := jobmonitor.NormalizeAlertsUserID(userID); err != nil {
		return nil, errors.New("the administrator's account id is not a Firebase uid, so nothing was created")
	}
	search, err := mcp.NormaliseAlertsSearch(in.Code, in.Threshold, in.Condition)
	if err != nil {
		return nil, err
	}
	core, err := a.alertsCoreFor()
	if err != nil {
		return nil, err
	}
	if a.alertJobs == nil {
		return nil, errors.New("job execution is not configured in this deployment")
	}
	entitled, err := a.entitled(userID)
	if err != nil {
		return nil, errors.New("failed to check subscription")
	}
	if !entitled {
		return nil, errors.New(alertsSmokeNeedsPremium)
	}
	email, err := a.alertsAddressFor(ctx, userID)
	if err != nil {
		return nil, err
	}

	ctx, cancel := context.WithTimeout(ctx, 50*time.Second)
	defer cancel()
	w, err := a.alerts.ReportWindow(ctx)
	if err != nil {
		return nil, errors.New("the report window could not be read")
	}
	var crossing shortsstore.AlertCrossing
	if in.Date != "" {
		if search.Code == "" {
			return nil, errors.New("give the code with the date: the date must be one the stock crossed on")
		}
		crossing, err = w.CrossingOn(search.Code, in.Date, search.Threshold)
		if err != nil {
			return nil, err
		}
	} else {
		var ok bool
		crossing, ok = w.FindShortInterestCrossing(search.Code, search.Threshold)
		if !ok {
			return nil, fmt.Errorf("no stock crossed %g in the last %d report dates, so there is nothing to replay", search.Threshold, shortsstore.AlertWindowDates)
		}
	}

	monitor, state, err := a.ensureSmokeMonitor(ctx, core, userID, email, crossing.Code, search.Threshold)
	if err != nil {
		return nil, err
	}

	// A replay's insert does nothing when the monitor already has an event for the
	// date. The job would then send nothing, and the old row would read as this run's
	// result. Refuse before the job runs.
	owned, existing, err := a.alerts.AdminAlertEventsOnDate(ctx, userID, monitor.ID, crossing.ReportDate)
	if err != nil {
		return nil, errors.New("the monitor's existing events could not be read, so nothing was replayed")
	}
	if owned && len(existing) > 0 {
		return nil, existingEventRefusal(monitor.ID, crossing.ReportDate, existing[0])
	}

	run, err := a.alertJobs.RunAlertsReplay(ctx, jobmonitor.AlertsReplayRequest{Date: crossing.ReportDate, UserID: userID, Actor: actor})
	if err != nil {
		return nil, alertsReplayError(err, monitor.ID)
	}
	return &mcp.RunAlertsSmokeOutput{
		MonitorID:      monitor.ID,
		MonitorState:   state,
		Code:           crossing.Code,
		Name:           crossing.Name,
		Date:           crossing.ReportDate,
		ComparedToDate: crossing.ComparedTo,
		PreviousDate:   crossing.PreviousDate,
		Previous:       crossing.Previous,
		Latest:         crossing.Latest,
		Threshold:      search.Threshold,
		Condition:      search.Condition,
		EmailTo:        mcp.MaskAlertEmail(email),
		Execution:      run.ExecutionName,
		Args:           run.Args,
		Also:           alsoEmailsNote,
		Next:           "call alerts_smoke_result with monitor_id, date and execution in one to two minutes",
	}, nil
}

// existingEventRefusal says why a replay was not started, and what to do next.
func existingEventRefusal(monitorID, date string, e shortsstore.AdminAlertEvent) error {
	return fmt.Errorf("monitor %s already has an alert event for %s (status %s, written %s, run %d), so a replay would send nothing and that row would read as this run's result. "+
		"Nothing was started. Pick another date with find_alert_crossing, or delete the monitor with delete_alert_monitor and run the smoke test again",
		monitorID, date, e.EmailStatus, e.CreatedAt.UTC().Format(time.RFC3339), e.RunID)
}

// ensureSmokeMonitor finds the caller's identical active daily monitor, or creates
// one through the shared rule. Pages through the caller's monitors so an identical
// one is found however many others the caller holds.
func (a *adminMCPSource) ensureSmokeMonitor(ctx context.Context, core alertsCore, userID, email, code string, threshold float64) (*shortsstore.AlertMonitor, string, error) {
	const page = 100
	for offset := int32(0); ; offset += page {
		monitors, total, _, err := core.listMonitors(ctx, userID, email, page, offset)
		if err != nil {
			return nil, "", err
		}
		for _, m := range monitors {
			if m.Status == alertevents.MonitorStatusActive && m.Scope == "stock" && m.Target == code &&
				m.Condition == "short_interest_above" && m.Cadence == "daily" && m.Threshold != nil && *m.Threshold == threshold {
				return m, "reused", nil
			}
		}
		if int(offset)+len(monitors) >= int(total) || len(monitors) == 0 {
			break
		}
	}
	monitor, err := core.createMonitor(ctx, userID, email, &shortsv1alpha1.CreateAlertMonitorRequest{
		Scope:        shortsv1alpha1.AlertMonitorScope_ALERT_MONITOR_SCOPE_STOCK,
		Target:       code,
		Condition:    shortsv1alpha1.AlertMonitorCondition_ALERT_MONITOR_CONDITION_SHORT_INTEREST_ABOVE,
		Cadence:      shortsv1alpha1.AlertMonitorCadence_ALERT_MONITOR_CADENCE_DAILY,
		Threshold:    threshold,
		HasThreshold: true,
	})
	if err != nil {
		return nil, "", err
	}
	return monitor, "created", nil
}

// alertsReplayError says why the replay did not start, and that the monitor was
// left in place. Unknown causes say nothing more than that.
func alertsReplayError(err error, monitorID string) error {
	left := fmt.Sprintf(" The monitor %s was left in place; delete it with delete_alert_monitor if it is not needed.", monitorID)
	var running *jobmonitor.AlreadyRunningError
	switch {
	case errors.As(err, &running):
		return fmt.Errorf("the alerts replay is already running (%s); wait for it to finish, then retry.%s", running.ExecutionName, left)
	case errors.Is(err, jobmonitor.ErrInvalidAlertsDate), errors.Is(err, jobmonitor.ErrInvalidAlertsUser):
		return fmt.Errorf("%w.%s", err, left)
	case errors.Is(err, jobmonitor.ErrUnknownJob), errors.Is(err, jobmonitor.ErrRetiredJob), errors.Is(err, jobmonitor.ErrNotExecutable):
		return fmt.Errorf("the shorted-alerts-replay job is not deployed in this environment.%s", left)
	case errors.Is(err, jobmonitor.ErrNoProject), errors.Is(err, jobmonitor.ErrOverridesUnsupported):
		return fmt.Errorf("job execution is not configured in this deployment.%s", left)
	}
	return fmt.Errorf("the replay could not be started; the job monitor rejected the request.%s", left)
}

// AlertsSmokeResult reads what the replay did for one of the caller's monitors on
// one date. A monitor that is not the caller's is not found, whatever it holds.
func (a *adminMCPSource) AlertsSmokeResult(ctx context.Context, userID string, in mcp.AlertsSmokeResultInput) (*mcp.AlertsSmokeResultOutput, error) {
	if a.alerts == nil {
		return nil, errAdminAlertsUnavailable
	}
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	owned, events, err := a.alerts.AdminAlertEventsOnDate(ctx, userID, in.MonitorID, in.Date)
	if err != nil {
		return nil, errors.New("the alert events could not be read")
	}
	if !owned {
		return nil, errAlertMonitorNotFound
	}
	out := &mcp.AlertsSmokeResultOutput{MonitorID: in.MonitorID, Date: in.Date, Events: []mcp.AlertsSmokeEvent{}}
	for _, e := range events {
		out.Events = append(out.Events, mcp.AlertsSmokeEvent{
			EmailStatus: e.EmailStatus, EmailAttempts: e.EmailAttempts, HasResendID: e.HasResendID,
			LastError: truncateAlertText(e.LastError, alertsErrorMessageLimit), Latest: e.LatestPercent, Previous: e.PreviousPercent,
			CreatedAt: e.CreatedAt.UTC().Format(time.RFC3339), RunID: e.RunID,
		})
	}
	stale := false
	if in.Execution != "" {
		if a.alertJobs == nil {
			return nil, errors.New("job execution is not configured in this deployment")
		}
		st, err := a.alertJobs.AlertsReplayResult(ctx, in.Execution)
		if err != nil {
			if errors.Is(err, jobmonitor.ErrInvalidExecution) {
				return nil, errors.New("that is not a valid execution name")
			}
			return nil, errors.New("the replay execution could not be read")
		}
		out.Replay = &mcp.AlertsReplayState{ExecutionName: st.ExecutionName, Status: st.Status, StartedAt: st.StartedAt,
			CompletedAt: st.CompletedAt, LogURI: st.LogUri, Message: st.Message}
		// A row written before this replay started belongs to an older run. Compare
		// against the execution's start; an unreadable start proves nothing either way.
		if started, perr := time.Parse(time.RFC3339Nano, st.StartedAt); perr == nil {
			for i := range events {
				if events[i].CreatedAt.Before(started) {
					out.Events[i].PredatesExecution = true
					stale = true
				}
			}
		}
	}
	out.Next = smokeResultNext(out.Events)
	if stale {
		out.Next += " This row was written before this replay started, so it is not this replay's result."
	}
	return out, nil
}

// smokeResultNext says what the events mean, in one line.
func smokeResultNext(events []mcp.AlertsSmokeEvent) string {
	if len(events) == 0 {
		return "No event for this monitor on this date. If the replay's execution has succeeded and this is still empty, the monitor did not fire on " +
			"that date: the stock did not cross for it, or the date was not replayable (the smoke test skips incomplete dates and the oldest end of the window)."
	}
	switch status := events[0].EmailStatus; status {
	case alertevents.StatusPending, alertevents.StatusSending, alertevents.StatusAwaitingEntitlement:
		return "Still queued for delivery. Check again in a minute."
	case alertevents.StatusSent:
		return "Sent to the verified address. Resend accepted it; check the inbox and the spam folder."
	default:
		return "Not delivered (" + status + "). Read lastError, and do not retry blindly."
	}
}

// DeleteOwnAlertMonitor deletes one of the caller's monitors through the shared rule.
func (a *adminMCPSource) DeleteOwnAlertMonitor(ctx context.Context, userID, monitorID string) error {
	core, err := a.alertsCoreFor()
	if err != nil {
		return err
	}
	return core.deleteMonitor(ctx, userID, monitorID)
}

// newAdminMCPSource builds the admin MCP operator for this server. serve.go mounts
// it, and the wiring test builds it the same way, so a field left out here is a
// failing test rather than a silently unconfigured tool.
func newAdminMCPSource(s *ShortsServer, firebaseUsers firebaseUsersReader) *adminMCPSource {
	return &adminMCPSource{
		Collector: s.jobsCollector,
		server:    s,
		people:    s.peopleStore,
		users:     firebaseUsers,
		billing:   billingStoreFrom(s.peopleStore),
		web:       newAdminWebClientFromEnv(),
		alerts:    alertsAdminStoreFrom(s.store),
		alertJobs: s.jobsCollector,
		entitled:  s.alertsCore().entitled,
		logger:    s.logger,
		verifiedEmail: func(ctx context.Context, uid string) (string, error) {
			return verifiedAccountEmail(ctx, firebaseUsers, uid)
		},
	}
}
