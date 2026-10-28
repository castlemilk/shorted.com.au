package otel

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"sync"
	"testing"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	otelmetric "go.opentelemetry.io/otel/metric"
	"go.opentelemetry.io/otel/trace"
	collectorv1 "go.opentelemetry.io/proto/otlp/collector/metrics/v1"
	tracev1 "go.opentelemetry.io/proto/otlp/collector/trace/v1"
	commonv1 "go.opentelemetry.io/proto/otlp/common/v1"
	metricsv1 "go.opentelemetry.io/proto/otlp/metrics/v1"
	"google.golang.org/protobuf/proto"
)

// Distinct stocks recorded in one collection must aggregate before export.
// Removing stock_code downstream would instead create duplicate series with
// the same timestamp, losing observations or rejecting an entire OTLP batch.
func TestLogoMetricsAggregateStockIdentityBeforeExport(t *testing.T) {
	preserveGlobalProviders(t)
	var mu sync.Mutex
	exported := map[string]*metricsv1.Metric{}
	var traceStock string
	sink := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Error(err)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		mu.Lock()
		defer mu.Unlock()
		switch r.URL.Path {
		case "/v1/metrics":
			var request collectorv1.ExportMetricsServiceRequest
			if err := proto.Unmarshal(body, &request); err != nil {
				t.Error(err)
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			for _, resource := range request.ResourceMetrics {
				for _, scope := range resource.ScopeMetrics {
					for _, metric := range scope.Metrics {
						exported[metric.Name] = metric
					}
				}
			}
		case "/v1/traces":
			var request tracev1.ExportTraceServiceRequest
			if err := proto.Unmarshal(body, &request); err != nil {
				t.Error(err)
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			for _, resource := range request.ResourceSpans {
				for _, scope := range resource.ScopeSpans {
					for _, span := range scope.Spans {
						for _, attr := range span.Attributes {
							if attr.Key == "stock_code" {
								traceStock = attr.Value.GetStringValue()
							}
						}
					}
				}
			}
		default:
			t.Errorf("unexpected export path %s", r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "application/x-protobuf")
	}))
	defer sink.Close()
	for _, signal := range []string{"", "_METRICS", "_TRACES"} {
		for _, option := range []string{"ENDPOINT", "HEADERS", "CERTIFICATE", "CLIENT_CERTIFICATE", "CLIENT_KEY", "COMPRESSION"} {
			t.Setenv("OTEL_EXPORTER_OTLP"+signal+"_"+option, "")
		}
	}
	t.Setenv("OTEL_EXPORTER_OTLP_ENDPOINT", sink.URL)
	t.Setenv("OTEL_TRACES_SAMPLER", "always_on")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	shutdown, err := InitProvider(ctx, "enrichment-processor")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = shutdown(context.Background()) }()
	for _, input := range []struct {
		stock, source, format string
		success               bool
		duration              float64
	}{
		{"AAA", "website", "png", true, 1.5},
		{"BBB", "website", "png", true, 2.5},
		{"CCC", "website", "svg", true, 7},
		{"DDD", "linkedin", "png", true, 12},
		{"EEE", "website", "png", false, 0.5},
	} {
		attrs := otelmetric.WithAttributes(
			attribute.String("stock_code", input.stock),
			attribute.String("arbitrary_detail", input.stock),
			attribute.String("logo.source", input.source),
			attribute.String("logo.format", input.format),
			attribute.Bool("logo.success", input.success),
		)
		LogoDiscoveryTotal.Add(ctx, 1, attrs)
		LogoDiscoveryDuration.Record(ctx, input.duration, attrs)
	}
	_, span := otel.Tracer("logo-test").Start(ctx, "logo.discovery", trace.WithAttributes(attribute.String("stock_code", "AAA")))
	span.End()
	if err := shutdown(ctx); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	defer mu.Unlock()
	if traceStock != "AAA" {
		t.Fatalf("trace stock detail changed: %q", traceStock)
	}
	counter := exported["shorted.logo.discovery_total"].GetSum()
	histogram := exported["shorted.logo.discovery_duration"].GetHistogram()
	if len(counter.GetDataPoints()) != 4 || len(histogram.GetDataPoints()) != 4 {
		t.Fatalf("want 4 bounded series per instrument, got counter=%d histogram=%d", len(counter.GetDataPoints()), len(histogram.GetDataPoints()))
	}
	key := func(attrs []*commonv1.KeyValue) string {
		t.Helper()
		values := map[string]string{}
		for _, attr := range attrs {
			switch attr.Key {
			case "logo.source", "logo.format":
				values[attr.Key] = attr.Value.GetStringValue()
			case "logo.success":
				if attr.Value.GetBoolValue() {
					values[attr.Key] = "true"
				} else {
					values[attr.Key] = "false"
				}
			default:
				t.Errorf("unbounded attribute exported: %s", attr.Key)
			}
		}
		return values["logo.source"] + "/" + values["logo.format"] + "/" + values["logo.success"]
	}
	wantCounts := map[string]int64{"website/png/true": 2, "website/svg/true": 1, "linkedin/png/true": 1, "website/png/false": 1}
	wantSums := map[string]float64{"website/png/true": 4, "website/svg/true": 7, "linkedin/png/true": 12, "website/png/false": 0.5}
	counts := map[string]int64{}
	var timestamp uint64
	for _, point := range counter.DataPoints {
		counts[key(point.Attributes)] = point.GetAsInt()
		if point.TimeUnixNano == 0 || (timestamp != 0 && point.TimeUnixNano != timestamp) {
			t.Fatal("counter observations must come from one collection timestamp")
		}
		timestamp = point.TimeUnixNano
	}
	if !reflect.DeepEqual(counts, wantCounts) {
		t.Fatalf("counter observations lost or semantic dimensions merged: got %v want %v", counts, wantCounts)
	}
	sums := map[string]float64{}
	timestamp = 0
	for _, point := range histogram.DataPoints {
		k := key(point.Attributes)
		sums[k] = point.GetSum()
		if point.Count != uint64(wantCounts[k]) {
			t.Errorf("histogram %s count=%d, want %d", k, point.Count, wantCounts[k])
		}
		if !reflect.DeepEqual(point.ExplicitBounds, []float64{1, 5, 10, 30, 60, 120, 300, 600, 1800, 3600}) {
			t.Errorf("logo duration bucket boundaries changed: %v", point.ExplicitBounds)
		}
		if k == "website/png/true" && !reflect.DeepEqual(point.BucketCounts, []uint64{0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0}) {
			t.Errorf("logo duration observations not aggregated: %v", point.BucketCounts)
		}
		if point.TimeUnixNano == 0 || (timestamp != 0 && point.TimeUnixNano != timestamp) {
			t.Fatal("histogram observations must come from one collection timestamp")
		}
		timestamp = point.TimeUnixNano
	}
	if !reflect.DeepEqual(sums, wantSums) {
		t.Fatalf("histogram observations lost or semantic dimensions merged: got %v want %v", sums, wantSums)
	}
}
