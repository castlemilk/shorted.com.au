package otel

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"go.opentelemetry.io/otel"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
)

func TestHTTPMetricsBoundMethodsAndPreserveTraceMethods(t *testing.T) {
	preserveGlobalProviders(t)
	reader := sdkmetric.NewManualReader()
	meterProvider := sdkmetric.NewMeterProvider(sdkmetric.WithReader(reader))
	spans := tracetest.NewSpanRecorder()
	tracerProvider := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(spans))
	otel.SetMeterProvider(meterProvider)
	otel.SetTracerProvider(tracerProvider)
	t.Cleanup(func() {
		_ = meterProvider.Shutdown(context.Background())
		_ = tracerProvider.Shutdown(context.Background())
	})

	methods := []string{http.MethodGet, http.MethodHead, http.MethodPost, http.MethodPut,
		http.MethodDelete, http.MethodConnect, http.MethodOptions, http.MethodTrace, http.MethodPatch}
	want := make(map[string]uint64)
	for _, method := range methods {
		want[method] = 1
	}
	for i := range 100 {
		methods = append(methods, fmt.Sprintf("CUSTOM-%d", i))
	}
	methods = append(methods, "get") // Method tokens are case sensitive.
	want["_OTHER"] = 101
	handler := HTTPMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	for _, method := range methods {
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, httptest.NewRequest(method, "/health", nil))
		if recorder.Code != http.StatusNoContent {
			t.Fatalf("handler status changed for %q: %d", method, recorder.Code)
		}
	}

	var metrics metricdata.ResourceMetrics
	if err := reader.Collect(context.Background(), &metrics); err != nil {
		t.Fatal(err)
	}
	found := false
	for _, scope := range metrics.ScopeMetrics {
		for _, metric := range scope.Metrics {
			if metric.Name != "http.server.duration" {
				continue
			}
			found = true
			histogram, ok := metric.Data.(metricdata.Histogram[float64])
			if !ok {
				t.Fatalf("HTTP duration is not a histogram: %T", metric.Data)
			}
			if len(histogram.DataPoints) != len(want) {
				t.Errorf("exported %d method series, want %d bounded series", len(histogram.DataPoints), len(want))
			}
			var observations uint64
			for _, point := range histogram.DataPoints {
				method, _ := point.Attributes.Value("http.method")
				if expected, known := want[method.AsString()]; !known || point.Count != expected {
					t.Errorf("method %q count=%d, want bounded method with count=%d", method.AsString(), point.Count, expected)
				}
				observations += point.Count
			}
			if observations != uint64(len(methods)) {
				t.Fatalf("lost HTTP observations: got %d, want %d", observations, len(methods))
			}
		}
	}
	if !found {
		t.Fatal("HTTP duration metric was not collected")
	}
	ended := spans.Ended()
	if len(ended) != len(methods) {
		t.Fatalf("got %d traces, want %d", len(ended), len(methods))
	}
	for i, span := range ended {
		var rawMethod string
		for _, attr := range span.Attributes() {
			if attr.Key == "http.method" {
				rawMethod = attr.Value.AsString()
			}
		}
		if rawMethod != methods[i] {
			t.Errorf("trace method changed: got %q, want %q", rawMethod, methods[i])
		}
	}
}
