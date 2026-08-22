package shorts

// jobs_validate.go implements /api/admin/jobs/validate-sync — on-demand,
// read-only, per-stock validation of the ASIC short-positions sync.
//
//	POST /api/admin/jobs/validate-sync   {"stocks":["BHP","DRO"]}
//	  → 202 {"executionName":"...","job":"shorts-data-sync","stocks":[...],"args":[...]}
//
//	GET  /api/admin/jobs/validate-sync?execution=<name>
//	  → 200 {"status":"running"}
//	  → 200 {"status":"succeeded","summary":{...}}
//	  → 200 {"status":"failed","message":"..."}
//	  → 502 {"error":"summary_not_found", ...}
//
// The GET reads the run's report from gs://<bucket>/validations/<execution>.json
// — a durable artifact the job publishes, NOT the execution's logs. See
// jobmonitor/validate.go for why that changed (project-level IAM is not
// grantable by the CI deploy service account).
//
// The handler is a courier. It never constructs job arguments and never names a
// Cloud Run resource: it forwards a stock-code list to jobmonitor, which
// validates the codes and builds the argv server-side. See validate.go for why
// that split is the whole security property.

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

// jobValidator is the slice of *jobmonitor.Collector this handler needs.
type jobValidator interface {
	RunValidation(ctx context.Context, req jobmonitor.ValidationRequest) (*jobmonitor.ValidationRun, error)
	ValidationResult(ctx context.Context, executionName string) (*jobmonitor.ValidationReport, error)
}

// maxValidateBody caps the request body: a list of at most 20 five-character
// codes. Anything larger is a mistake or an attack.
const maxValidateBody = 4096

// validationPollTimeout bounds the GET. A poll reads one execution and one page
// of logs; if that has not returned in 30s the console should retry rather than
// hold a connection open.
const validationPollTimeout = 30 * time.Second

// adminJobsValidateSyncHandler builds the POST+GET handler.
func adminJobsValidateSyncHandler(logger *log.Logger, validator jobValidator) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization, x-internal-secret, x-admin-actor")

		switch r.Method {
		case http.MethodOptions:
			w.WriteHeader(http.StatusOK)
		case http.MethodPost:
			startValidation(w, r, logger, validator)
		case http.MethodGet:
			pollValidation(w, r, logger, validator)
		default:
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		}
	}
}

// startValidation handles POST: start a shadow validation run.
func startValidation(w http.ResponseWriter, r *http.Request, logger *log.Logger, validator jobValidator) {
	var body struct {
		Stocks []string `json:"stocks"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, maxValidateBody)).Decode(&body); err != nil {
		writeJobRunError(w, http.StatusBadRequest, "invalid_body",
			`Request body must be JSON: {"stocks":["BHP","DRO"]}`)
		return
	}

	actor := r.Header.Get("x-admin-actor")
	if actor == "" {
		actor = "unknown (internal secret)"
	}

	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()

	res, err := validator.RunValidation(ctx, jobmonitor.ValidationRequest{
		Stocks: body.Stocks,
		Actor:  actor,
	})
	if err != nil {
		writeValidationFailure(w, logger, actor, err)
		return
	}

	// AUDIT: who validated what. The constructed argv is logged too — it is the
	// only thing that actually ran, and it is not caller-supplied.
	logger.Infof("AUDIT jobs/validate-sync actor=%q job=%q region=%q execution=%q stocks=%v args=%v",
		actor, res.Job, res.Region, res.ExecutionName, res.Stocks, res.Args)

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusAccepted)
	if err := json.NewEncoder(w).Encode(res); err != nil {
		logger.Errorf("Error encoding validation run response: %v", err)
	}
}

// pollValidation handles GET: fetch the outcome of a validation run.
func pollValidation(w http.ResponseWriter, r *http.Request, logger *log.Logger, validator jobValidator) {
	execution := r.URL.Query().Get("execution")
	if execution == "" {
		writeJobRunError(w, http.StatusBadRequest, "invalid_body",
			"Query parameter `execution` is required.")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), validationPollTimeout)
	defer cancel()

	rep, err := validator.ValidationResult(ctx, execution)
	if errors.Is(err, jobmonitor.ErrSummaryNotFound) {
		// A real, specific failure — reported as one rather than as an empty
		// success. The partial report (status + the message naming the object
		// that is missing + the log link) still travels, because that is
		// exactly what an operator needs to diagnose it.
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadGateway)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"error":   "summary_not_found",
			"message": rep.Message,
			"status":  rep.Status,
			"logUri":  rep.LogUri,
		})
		return
	}
	if err != nil {
		writeValidationFailure(w, logger, "poll", err)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(rep); err != nil {
		logger.Errorf("Error encoding validation report: %v", err)
	}
}

// writeValidationFailure maps a jobmonitor refusal onto its HTTP status.
func writeValidationFailure(w http.ResponseWriter, logger *log.Logger, actor string, err error) {
	switch {
	case errors.Is(err, jobmonitor.ErrInvalidStocks):
		// The message is safe to echo: it only ever quotes the offending token.
		writeJobRunError(w, http.StatusBadRequest, "invalid_stocks", err.Error())
	case errors.Is(err, jobmonitor.ErrInvalidExecution):
		writeJobRunError(w, http.StatusBadRequest, "invalid_execution",
			"That is not a valid Cloud Run execution name.")
	case errors.Is(err, jobmonitor.ErrUnknownJob):
		logger.Warnf("jobs/validate-sync DENIED: %s is not in the collected fleet (actor %s)",
			jobmonitor.ValidationJobName, actor)
		writeJobRunError(w, http.StatusNotFound, "unknown_job",
			"The shorts-data-sync job is not in the collected fleet.")
	case errors.Is(err, jobmonitor.ErrNotExecutable):
		writeJobRunError(w, http.StatusConflict, "not_executable",
			"The shorts-data-sync row is not a Cloud Run Job — there is nothing to execute.")
	case errors.Is(err, jobmonitor.ErrRetiredJob):
		writeJobRunError(w, http.StatusConflict, "retired",
			"The shorts-data-sync job is retired; validate its replacement instead.")
	case errors.Is(err, jobmonitor.ErrNoProject):
		writeJobRunError(w, http.StatusServiceUnavailable, "not_configured",
			"Job execution is not configured (JOBS_GCP_PROJECT unset).")
	case errors.Is(err, jobmonitor.ErrOverridesUnsupported):
		writeJobRunError(w, http.StatusServiceUnavailable, "not_configured",
			"This deployment cannot start override runs.")
	case errors.Is(err, jobmonitor.ErrNoBucket):
		writeJobRunError(w, http.StatusServiceUnavailable, "not_configured",
			"Validation report retrieval is not configured (SHORTS_DATA_BUCKET unset).")
	default:
		logger.Errorf("jobs/validate-sync FAILED actor=%s: %v", actor, err)
		writeJobRunError(w, http.StatusBadGateway, "validation_failed",
			"Cloud Run rejected the validation request. Check the service account has roles/run.developer on shorts-data-sync (roles/run.invoker alone cannot pass argument overrides).")
	}
}
