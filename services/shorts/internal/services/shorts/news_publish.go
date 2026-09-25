package shorts

// news_publish.go implements /api/admin/news/publish — publish one merged,
// hand-written article (content/news/*.mdx) to /news from anywhere that holds
// the internal secret, without prod credentials on the caller's machine.
//
//	POST /api/admin/news/publish   {"slug":"<slug>","images":true,"force":false}
//	  → 202 {"executionName":"...","job":"shorted-news-publish","slug":"...","args":[...],"url":"..."}
//
//	GET  /api/admin/news/publish?execution=<name>
//	  → 200 {"status":"running"|"succeeded"|"failed", "logUri":..., "message":...}
//
// The work happens in the shorted-news-publish Cloud Run job (take-writer
// `publish-content`), which holds DATABASE_URL, the model keys, the
// revalidation secret and GCS write access. The handler is a courier: it never
// constructs job arguments and never names a Cloud Run resource. See
// jobmonitor/publish.go for why that split is the security property.

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

// newsPublisher is the slice of *jobmonitor.Collector this handler needs.
type newsPublisher interface {
	RunPublish(ctx context.Context, req jobmonitor.PublishRequest) (*jobmonitor.PublishRun, error)
	PublishResult(ctx context.Context, executionName string) (*jobmonitor.PublishStatus, error)
}

// maxPublishBody caps the request body: one slug and two booleans.
const maxPublishBody = 4096

func adminNewsPublishHandler(logger *log.Logger, publisher newsPublisher) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization, x-internal-secret, x-admin-actor")

		switch r.Method {
		case http.MethodOptions:
			w.WriteHeader(http.StatusOK)
		case http.MethodPost:
			startNewsPublish(w, r, logger, publisher)
		case http.MethodGet:
			pollNewsPublish(w, r, logger, publisher)
		default:
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		}
	}
}

func startNewsPublish(w http.ResponseWriter, r *http.Request, logger *log.Logger, publisher newsPublisher) {
	var body struct {
		Slug string `json:"slug"`
		// Images is a pointer so that omitting it means the default (ON), not
		// false: an article must not go live without its hero by accident.
		Images *bool `json:"images"`
		Force  bool  `json:"force"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, maxPublishBody)).Decode(&body); err != nil {
		writeJobRunError(w, http.StatusBadRequest, "invalid_body",
			`Request body must be JSON: {"slug":"<article-slug>"}`)
		return
	}

	actor := r.Header.Get("x-admin-actor")
	if actor == "" {
		actor = "unknown (internal secret)"
	}

	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()

	res, err := publisher.RunPublish(ctx, jobmonitor.PublishRequest{
		Slug:       body.Slug,
		SkipImages: body.Images != nil && !*body.Images,
		Force:      body.Force,
		Actor:      actor,
	})
	if err != nil {
		writeNewsPublishFailure(w, logger, actor, err)
		return
	}

	// AUDIT: who published what. The argv is logged because it is the only
	// thing that actually ran, and it is not caller-supplied.
	logger.Infof("AUDIT news/publish actor=%q job=%q region=%q execution=%q slug=%q args=%v forced=%t",
		actor, res.Job, res.Region, res.ExecutionName, res.Slug, res.Args, body.Force)

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusAccepted)
	if err := json.NewEncoder(w).Encode(res); err != nil {
		logger.Errorf("Error encoding publish run response: %v", err)
	}
}

func pollNewsPublish(w http.ResponseWriter, r *http.Request, logger *log.Logger, publisher newsPublisher) {
	execution := r.URL.Query().Get("execution")
	if execution == "" {
		writeJobRunError(w, http.StatusBadRequest, "invalid_body", "Query parameter `execution` is required.")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()

	st, err := publisher.PublishResult(ctx, execution)
	if err != nil {
		writeNewsPublishFailure(w, logger, "poll", err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(st); err != nil {
		logger.Errorf("Error encoding publish status: %v", err)
	}
}

// writeNewsPublishFailure maps a jobmonitor refusal onto its HTTP status.
func writeNewsPublishFailure(w http.ResponseWriter, logger *log.Logger, actor string, err error) {
	var running *jobmonitor.AlreadyRunningError
	switch {
	case errors.Is(err, jobmonitor.ErrInvalidSlug):
		// Safe to echo: the message only ever quotes the offending slug.
		writeJobRunError(w, http.StatusBadRequest, "invalid_slug", err.Error())
	case errors.Is(err, jobmonitor.ErrInvalidExecution):
		writeJobRunError(w, http.StatusBadRequest, "invalid_execution",
			"That is not a valid Cloud Run execution name.")
	case errors.Is(err, jobmonitor.ErrUnknownJob):
		logger.Warnf("news/publish DENIED: %s is not in the collected fleet (actor %s)", jobmonitor.PublishJobName, actor)
		writeJobRunError(w, http.StatusNotFound, "unknown_job",
			"The shorted-news-publish job is not deployed in this environment.")
	case errors.Is(err, jobmonitor.ErrNotExecutable), errors.Is(err, jobmonitor.ErrRetiredJob):
		writeJobRunError(w, http.StatusConflict, "not_executable",
			"The shorted-news-publish row cannot be executed.")
	case errors.As(err, &running):
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
	case errors.Is(err, jobmonitor.ErrNoProject), errors.Is(err, jobmonitor.ErrOverridesUnsupported):
		writeJobRunError(w, http.StatusServiceUnavailable, "not_configured",
			"Job execution is not configured in this deployment.")
	default:
		logger.Errorf("news/publish FAILED actor=%s: %v", actor, err)
		writeJobRunError(w, http.StatusBadGateway, "publish_failed",
			"Cloud Run rejected the publish request. Check the shorts-api service account has roles/run.developer on shorted-news-publish.")
	}
}
