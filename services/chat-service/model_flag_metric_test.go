package main

import (
	"context"
	"testing"
	"time"

	shortedotel "github.com/castlemilk/shorted.com.au/services/pkg/otel"
	"go.opentelemetry.io/otel/attribute"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"
)

// TestChatModelFlagCountsEachTurnOnce checks the counter records one outcome per
// turn, with the outcome as its attribute.
func TestChatModelFlagCountsEachTurnOnce(t *testing.T) {
	reader := sdkmetric.NewManualReader()
	provider := sdkmetric.NewMeterProvider(sdkmetric.WithReader(reader))
	meter := provider.Meter("test")
	counter, err := meter.Int64Counter("shorted.chat.model_flag_evaluations_total")
	if err != nil {
		t.Fatalf("Int64Counter() error = %v", err)
	}
	prev := shortedotel.ChatModelFlagEvaluations
	shortedotel.ChatModelFlagEvaluations = counter
	t.Cleanup(func() { shortedotel.ChatModelFlagEvaluations = prev })

	s := newChatModelSelector(fixedFlag("deepseek:deepseek-flash"), "gemini:gemini-2.5-flash", "production",
		flaggedRoutes("deepseek:deepseek-flash"), flagTiming{Turn: time.Second, TTL: time.Second})
	choiceOf(s, "uid-owner") // flag
	choiceOf(s, "uid-owner") // cache

	var rm metricdata.ResourceMetrics
	if err := reader.Collect(context.Background(), &rm); err != nil {
		t.Fatalf("Collect() error = %v", err)
	}
	got := map[string]int64{}
	for _, sm := range rm.ScopeMetrics {
		for _, m := range sm.Metrics {
			sum, ok := m.Data.(metricdata.Sum[int64])
			if !ok || m.Name != "shorted.chat.model_flag_evaluations_total" {
				continue
			}
			for _, dp := range sum.DataPoints {
				v, _ := dp.Attributes.Value(attribute.Key("outcome"))
				got[v.AsString()] += dp.Value
			}
		}
	}
	if got[flagOutcomeFlag] != 1 || got[flagOutcomeCache] != 1 || len(got) != 2 {
		t.Fatalf("counts = %v, want one flag and one cache", got)
	}
}
