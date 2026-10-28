package main

import (
	"context"
	"time"

	"github.com/castlemilk/shorted.com.au/services/pkg/log"
	shortedotel "github.com/castlemilk/shorted.com.au/services/pkg/otel"
	"go.opentelemetry.io/otel/attribute"
	otelmetric "go.opentelemetry.io/otel/metric"
)

func shutdownTelemetry(shutdown func(context.Context) error) {
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := shutdown(shutdownCtx); err != nil {
		log.Errorf("error shutting down OpenTelemetry: %v", err)
	}
}

func runBatchWithMetrics(ctx context.Context, logger *log.Logger, runJob func(context.Context) error) int {
	logger.Infof("Running in batch mode")
	syncAttrs := otelmetric.WithAttributes(attribute.String("sync_job", "enrichment-processor"))
	batchStart := time.Now()
	batchErr := runJob(ctx)
	shortedotel.SyncDuration.Record(ctx, time.Since(batchStart).Seconds(), syncAttrs)
	if batchErr != nil {
		shortedotel.SyncStatus.Add(ctx, 1, otelmetric.WithAttributes(
			attribute.String("sync_job", "enrichment-processor"),
			attribute.String("status", "failure"),
		))
		logger.Errorf("Batch enrichment failed: %v", batchErr)
		return 1
	}
	shortedotel.SyncStatus.Add(ctx, 1, otelmetric.WithAttributes(
		attribute.String("sync_job", "enrichment-processor"),
		attribute.String("status", "success"),
	))
	shortedotel.SyncLastSuccess.Record(ctx, time.Now().Unix(), syncAttrs)
	logger.Infof("Batch enrichment completed successfully")
	return 0
}
