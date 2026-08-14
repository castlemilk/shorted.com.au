package marketdata

import (
	"context"
	"log"
	"time"

	shortedotel "github.com/castlemilk/shorted.com.au/services/pkg/otel"
)

// otelShutdownTimeout matches the standalone binary's 30s flush window. It is
// generous on purpose: Cloud Run kills the container right after the process
// returns, so an unflushed batch is a lost run's telemetry.
const otelShutdownTimeout = 30 * time.Second

// startOTel initialises traces + metrics via OTLP and returns the shutdown
// func to defer. A no-op when OTEL_EXPORTER_OTLP_ENDPOINT is unset, and
// non-fatal on failure (the standalone binary also only warned).
func startOTel(ctx context.Context) func() {
	shutdown, err := shortedotel.InitProvider(ctx, otelServiceName)
	if err != nil {
		log.Printf("⚠️ Failed to initialize OTel: %v", err)
		return func() {}
	}
	return func() {
		// A detached context: ctx is already cancelled by the time this runs on
		// the SIGTERM path, and a cancelled context flushes nothing.
		shutdownCtx, cancel := context.WithTimeout(context.Background(), otelShutdownTimeout)
		defer cancel()
		if err := shutdown(shutdownCtx); err != nil {
			log.Printf("⚠️ OTel shutdown error: %v", err)
		}
	}
}
