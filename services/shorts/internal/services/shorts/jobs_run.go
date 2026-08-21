package shorts

// jobs_run.go implements POST /api/admin/jobs/run — on-demand execution of a
// scheduled job from the admin console.
//
// The endpoint is deliberately thin: every safety decision (does this job exist,
// is it retired, is it already running) lives in jobmonitor, which validates
// against the fleet it has actually observed. This file only maps those outcomes
// onto HTTP and writes the audit line.

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"time"

	"github.com/castlemilk/shorted.com.au/services/pkg/log"
	"github.com/castlemilk/shorted.com.au/services/shorts/internal/jobmonitor"
)

// jobRunner is the slice of *jobmonitor.Collector this handler needs. An
// interface so the handler is testable without GCP credentials.
type jobRunner interface {
	RunJob(ctx context.Context, req jobmonitor.RunRequest) (*jobmonitor.RunResult, error)
}

// maxJobRunBody caps the request body. The payload is three small fields; a
// bigger body is a mistake or an attack, never a legitimate call.
const maxJobRunBody = 4096

// adminJobsRunHandler builds the POST /api/admin/jobs/run handler.
//
// Body: {"job":"shorted-news","region":"australia-southeast2","force":false}
//
// Semantics:
//   - 404 unknown_job     — not in the collected fleet (or the region disagrees)
//   - 409 not_executable  — a scheduler-only service row or a residential rig
//   - 409 retired         — superseded by design; run its replacement
//   - 409 already_running — an execution is in flight; retry with force:true
//   - 202 + execution name on success
//
// force exists because the ASIC short-positions sync legitimately runs 26-29h:
// a parallel run must be POSSIBLE, just never accidental.
func adminJobsRunHandler(logger *log.Logger, runner jobRunner) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization, x-internal-secret, x-admin-actor")

		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusOK)
			return
		}
		if r.Method != http.MethodPost {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}

		var body struct {
			Job    string `json:"job"`
			Region string `json:"region"`
			Force  bool   `json:"force"`
		}
		if err := json.NewDecoder(io.LimitReader(r.Body, maxJobRunBody)).Decode(&body); err != nil {
			writeJobRunError(w, http.StatusBadRequest, "invalid_body", `Request body must be JSON: {"job":"..."}`)
			return
		}

		// The audit identity. The web server action forwards the admin's verified
		// email; a direct caller holding the internal secret has none, and says so.
		actor := r.Header.Get("x-admin-actor")
		if actor == "" {
			actor = "unknown (internal secret)"
		}

		ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
		defer cancel()

		res, err := runner.RunJob(ctx, jobmonitor.RunRequest{
			Job:    body.Job,
			Region: body.Region,
			Force:  body.Force,
			Actor:  actor,
		})
		if err != nil {
			writeJobRunFailure(w, logger, body.Job, body.Region, actor, err)
			return
		}

		// AUDIT: who ran what, where, and whether they overrode the running guard.
		logger.Infof("AUDIT jobs/run actor=%q job=%q region=%q execution=%q forced=%t previous=%q",
			actor, res.Job, res.Region, res.ExecutionName, res.Forced, res.PreviousExecution)

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusAccepted)
		if err := json.NewEncoder(w).Encode(res); err != nil {
			logger.Errorf("Error encoding job run response: %v", err)
		}
	}
}

// writeJobRunFailure maps a jobmonitor refusal onto its HTTP status. Refusals
// are client-visible and specific; anything else is deliberately generic.
func writeJobRunFailure(w http.ResponseWriter, logger *log.Logger, job, region, actor string, err error) {
	var running *jobmonitor.AlreadyRunningError
	switch {
	case errors.Is(err, jobmonitor.ErrUnknownJob):
		logger.Warnf("jobs/run DENIED unknown job %q (region %q) by %s", job, region, actor)
		writeJobRunError(w, http.StatusNotFound, "unknown_job",
			"No such job in the collected fleet.")
	case errors.Is(err, jobmonitor.ErrNotExecutable):
		writeJobRunError(w, http.StatusConflict, "not_executable",
			"This row is not a Cloud Run Job (scheduler-only service or residential rig) — there is nothing to execute.")
	case errors.Is(err, jobmonitor.ErrRetiredJob):
		writeJobRunError(w, http.StatusConflict, "retired",
			"This job is retired (superseded); run its replacement instead.")
	case errors.As(err, &running):
		// The only forceable refusal — the response says so explicitly so the UI
		// can offer the override without hardcoding which errors are overridable.
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusConflict)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"error":             "already_running",
			"message":           running.Error(),
			"executionName":     running.ExecutionName,
			"startedAt":         running.StartedAt,
			"runningForSeconds": running.Age.Seconds(),
			"forceable":         true,
		})
	case errors.Is(err, jobmonitor.ErrNoProject):
		writeJobRunError(w, http.StatusServiceUnavailable, "not_configured",
			"Job execution is not configured (JOBS_GCP_PROJECT unset).")
	default:
		logger.Errorf("jobs/run FAILED job=%q actor=%s: %v", job, actor, err)
		writeJobRunError(w, http.StatusBadGateway, "run_failed",
			"Cloud Run rejected the execution request. Check the service account has roles/run.invoker on this job.")
	}
}
