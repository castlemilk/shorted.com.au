package jobmonitor

// picks.go adds a third constrained override-run: execute the stock picker's
// data job, `shorted picks`, in ONE of its four modes.
//
// It follows validate.go and publish.go exactly (read validate.go's header
// first), and exists for the same reason they do. The deployed args of
// shorted-picks are `picks -mode refresh`, so the fleet-wide "Run now" (RunJob,
// no overrides) can only ever refresh the views. The fundamentals pull and the
// filings ingest are scheduler overrides — and building first coverage in a
// new environment means running them on demand, which until now meant an
// operator with gcloud. The admin MCP server drives this method so an
// administrator can do it from an agent instead.
//
//  1. IAM: roles/run.developer (the role carrying runWithOverrides) is granted
//     on exactly ONE more job, shorted-picks — see
//     terraform/environments/prod/main.tf. Nothing else in the fleet becomes
//     override-able.
//  2. The argv is BUILT HERE from a closed enum. A caller names a MODE, and the
//     mode is matched against the four strings the job's own flag parser
//     accepts (services/jobs/internal/jobs/picks/job.go). There is no code
//     path by which caller text becomes an argv element: an unknown mode is
//     refused before GCP is touched, and the subcommand and flag name are
//     constants of this file.
//
// The already-running guard DOES apply. Every mode but a dry run writes
// (stock_fundamentals, stock_fundamentals_sync, and the view refresh), and two
// concurrent fundamentals runs would both take the stalest codes first and
// race on the same rows. Force is available for a stuck execution.

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"
)

// PicksJobName is the ONLY job this method can execute. A constant, for the
// same reason as ValidationJobName and PublishJobName: the IAM elevation is
// scoped to this one job and the method must not be able to aim elsewhere.
const PicksJobName = "shorted-picks"

// picksSubcommand is the job binary's subcommand (the image ENTRYPOINT is
// /shorted; the deployed args are ["picks", "-mode", "refresh"]).
const picksSubcommand = "picks"

// PicksMode is one of the four modes `shorted picks -mode` accepts.
type PicksMode string

// The modes, spelled exactly as the job's flag parser wants them
// (services/jobs/internal/jobs/picks/job.go). Change one, change the other.
const (
	// PicksModeFundamentals pulls the full statements (Yahoo, Markit per-field
	// fallback) for every code in priority order until
	// PICKS_FUNDAMENTALS_BUDGET_MIN (170 minutes) elapses.
	// PICKS_FUNDAMENTALS_MAX_CODES is an optional count cap prod leaves unset.
	PicksModeFundamentals PicksMode = "fundamentals"
	// PicksModeFilings is the fail-closed, deterministic rebuild of the
	// filing rows from the report-extractor's statutory results extractions
	// (exit 10 when the write is refused, nothing written). DB-only, seconds.
	PicksModeFilings PicksMode = "filings"
	// PicksModeRefresh runs refresh_strategy_views().
	PicksModeRefresh PicksMode = "refresh"
	// PicksModeAll is fundamentals, then filings, then refresh — what the daily
	// 15:00 UTC schedule runs.
	PicksModeAll PicksMode = "all"
)

// PicksModes is every mode, in the order the job documents them.
var PicksModes = []PicksMode{PicksModeFundamentals, PicksModeFilings, PicksModeRefresh, PicksModeAll}

// ErrInvalidPicksMode: the requested mode is not one of PicksModes.
var ErrInvalidPicksMode = errors.New("jobmonitor: invalid picks mode")

// PicksRequest is a request to run the picks job once. Note what is NOT here:
// no job name, no region, no arguments, no code list.
type PicksRequest struct {
	Mode string
	// Force overrides the already-running guard.
	Force bool
	// Actor is the admin identity, for the audit log only.
	Actor string
}

// PicksRun describes the execution that was created.
type PicksRun struct {
	Job           string    `json:"job"`
	Region        string    `json:"region"`
	ExecutionName string    `json:"executionName"`
	Mode          PicksMode `json:"mode"`
	// Args is the argv this service constructed. Output, never input.
	Args []string `json:"args"`
}

// NormalizePicksMode validates a caller-supplied mode against the closed set.
// Case is folded (the set is closed, so "Refresh" cannot mean anything but
// "refresh"); nothing else is repaired.
func NormalizePicksMode(in string) (PicksMode, error) {
	mode := strings.ToLower(strings.TrimSpace(in))
	if mode == "" {
		return "", fmt.Errorf("%w: no mode supplied (want %s)", ErrInvalidPicksMode, picksModeList())
	}
	for _, m := range PicksModes {
		if string(m) == mode {
			return m, nil
		}
	}
	return "", fmt.Errorf("%w: %q (want %s)", ErrInvalidPicksMode, in, picksModeList())
}

func picksModeList() string {
	names := make([]string, 0, len(PicksModes))
	for _, m := range PicksModes {
		names = append(names, string(m))
	}
	return strings.Join(names, "|")
}

// picksArgs builds the argv. Pure and total: given a mode that passed
// NormalizePicksMode, the result can only ever be a `picks -mode <mode>` run.
func picksArgs(mode PicksMode) []string {
	return []string{picksSubcommand, "-mode", string(mode)}
}

// RunPicks starts one execution of the picks job in the requested mode.
//
// Validation order: mode (400) before project config (503) before job
// resolution (404/409) before the running guard (409, forceable).
func (c *Collector) RunPicks(ctx context.Context, req PicksRequest) (*PicksRun, error) {
	mode, err := NormalizePicksMode(req.Mode)
	if err != nil {
		return nil, err
	}
	target, err := c.resolveNamedTarget(ctx, PicksJobName)
	if err != nil {
		return nil, err
	}
	if isRunning(target) && !req.Force {
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
	args := picksArgs(mode)
	execName, err := overrider.RunWithArgs(ctx, c.cfg.ProjectID, target.Region, target.Name, args)
	if err != nil {
		return nil, err
	}
	c.Invalidate()

	return &PicksRun{
		Job:           target.Name,
		Region:        target.Region,
		ExecutionName: execName,
		Mode:          mode,
		Args:          args,
	}, nil
}

// PicksResult polls one picks execution. Like a publish, the job has no report
// artifact: its exit code is the verdict (0 ok, 10 DEGRADED, 1 failed), so the
// execution state and its log link are the whole answer.
func (c *Collector) PicksResult(ctx context.Context, executionName string) (*ExecutionStatus, error) {
	return c.executionStatus(ctx, PicksJobName, executionName)
}
