package ingest

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"time"

	"github.com/castlemilk/shorted.com.au/services/pkg/log"
)

// Serve runs the dedicated ingest service (SHORTS_SERVE_MODE=ingest). It mounts
// CrawlIngestService and the health routes, and nothing else: no public services,
// no OAuth, no MCP, no CORS. It opens its own pool. This is the process S-SRV deploys
// as a separate Cloud Run service from the same image.
//
// It refuses to start without HOUSING_INGEST_ENABLED=true or without a database URL.
// Both are deploy errors, and a dedicated service with nothing to do should fail
// loudly instead of answering every rig with Unavailable. A bad config value (a
// missing org, an invalid allowlist) is not refused here: the service still serves, so
// the rig gets a retryable Unavailable and the reason is logged.
func Serve(ctx context.Context, addr string) error {
	cfg, problem := ConfigFromEnv(os.Getenv)
	LogStartup(cfg, problem)
	if !cfg.Enabled {
		return fmt.Errorf("%s=%s requires %s=true", EnvServeMode, ServeModeIngest, EnvEnabled)
	}
	pool, err := OpenPool(ctx, os.Getenv, cfg)
	if err != nil {
		return err
	}
	defer pool.Close()

	svc := New(ctx, Options{Config: cfg, ConfigProblem: problem, Pool: pool})
	path, h := svc.Handler()
	mux := http.NewServeMux()
	mux.Handle(path, h)
	mux.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("OK"))
	})
	mux.Handle("/health/ingest", HealthHandler(svc))

	srv := &http.Server{
		Addr:              addr,
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
	}
	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := srv.Shutdown(shutdownCtx); err != nil {
			log.Errorf("housing ingest: shutdown: %v", err)
		}
	}()
	log.Infof("housing ingest service listening on %s", addr)
	err = srv.ListenAndServe()
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}
