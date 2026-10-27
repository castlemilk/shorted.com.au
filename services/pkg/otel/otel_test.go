package otel

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"go.opentelemetry.io/otel"
	metricnoop "go.opentelemetry.io/otel/metric/noop"
	tracenoop "go.opentelemetry.io/otel/trace/noop"
	metricsv1 "go.opentelemetry.io/proto/otlp/collector/metrics/v1"
	tracev1 "go.opentelemetry.io/proto/otlp/collector/trace/v1"
	commonv1 "go.opentelemetry.io/proto/otlp/common/v1"
	"google.golang.org/protobuf/proto"
)

func preserveGlobalProviders(t *testing.T) {
	t.Helper()
	meter, tracer, propagator := otel.GetMeterProvider(), otel.GetTracerProvider(), otel.GetTextMapPropagator()
	t.Cleanup(func() {
		otel.SetMeterProvider(meter)
		otel.SetTracerProvider(tracer)
		if !reflect.DeepEqual(otel.GetTextMapPropagator(), propagator) {
			otel.SetTextMapPropagator(propagator)
		}
		InitCustomMetrics()
	})
}

// Exercise the real HTTP exporters and shutdown flush, rather than only
// checking a Resource construction helper that might not reach both signals.
func exportResource(t *testing.T, service string) map[string]string {
	t.Helper()
	preserveGlobalProviders(t)
	var mu sync.Mutex
	resources := map[string][]*commonv1.KeyValue{}
	sink := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			http.Error(w, "read body", 500)
			return
		}
		mu.Lock()
		defer mu.Unlock()
		switch r.URL.Path {
		case "/v1/metrics":
			var request metricsv1.ExportMetricsServiceRequest
			if err := proto.Unmarshal(body, &request); err != nil {
				http.Error(w, "decode metrics", 400)
				return
			}
			for _, resource := range request.ResourceMetrics {
				for _, scope := range resource.ScopeMetrics {
					for _, metric := range scope.Metrics {
						if metric.Name == "test.identity.counter" && len(metric.GetSum().DataPoints) == 1 && metric.GetSum().DataPoints[0].GetAsInt() == 1 {
							resources["metrics"] = resource.Resource.Attributes
						}
					}
				}
			}
		case "/v1/traces":
			var request tracev1.ExportTraceServiceRequest
			if err := proto.Unmarshal(body, &request); err != nil {
				http.Error(w, "decode traces", 400)
				return
			}
			for _, resource := range request.ResourceSpans {
				for _, scope := range resource.ScopeSpans {
					for _, span := range scope.Spans {
						if span.Name == "test.identity.span" {
							resources["traces"] = resource.Resource.Attributes
						}
					}
				}
			}
		default:
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/x-protobuf")
		w.WriteHeader(http.StatusOK)
	}))
	defer sink.Close()
	// Do not inherit production endpoints or credentials into this local test.
	for _, signal := range []string{"", "_METRICS", "_TRACES"} {
		for _, option := range []string{"ENDPOINT", "HEADERS", "CERTIFICATE", "CLIENT_CERTIFICATE", "CLIENT_KEY", "COMPRESSION"} {
			t.Setenv("OTEL_EXPORTER_OTLP"+signal+"_"+option, "")
		}
	}
	t.Setenv("OTEL_EXPORTER_OTLP_ENDPOINT", sink.URL)
	t.Setenv("OTEL_TRACES_SAMPLER", "always_on")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	shutdown, err := InitProvider(ctx, service)
	if err != nil {
		t.Fatal(err)
	}
	shutdownNeeded := true
	defer func() {
		if shutdownNeeded {
			if err := shutdown(context.Background()); err != nil {
				t.Errorf("cleanup exporters: %v", err)
			}
		}
	}()
	counter, err := otel.Meter("identity-test").Int64Counter("test.identity.counter")
	if err != nil {
		t.Fatal(err)
	}
	counter.Add(ctx, 1)
	_, span := otel.Tracer("identity-test").Start(ctx, "test.identity.span")
	span.End()
	err = shutdown(ctx)
	shutdownNeeded = false
	if err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	defer mu.Unlock()
	var result map[string]string
	for _, signal := range []string{"metrics", "traces"} {
		attrs := map[string]string{}
		for _, kv := range resources[signal] {
			attrs[kv.Key] = kv.Value.GetStringValue()
		}
		if attrs["service.name"] != service {
			t.Fatalf("%s service.name=%q, want %q", signal, attrs["service.name"], service)
		}
		id := attrs["service.instance.id"]
		parsed, err := uuid.Parse(id)
		if err != nil || parsed.Version() != 4 {
			t.Fatalf("%s must carry a random process instance UUID, got %q", signal, id)
		}
		if result != nil && result["service.instance.id"] != id {
			t.Fatal("metrics and traces must share one process identity")
		}
		result = attrs
	}
	return result
}

func TestProviderExportsStableProcessIdentity(t *testing.T) {
	t.Setenv("SERVICE_VERSION", "test-sha")
	t.Setenv("ENVIRONMENT", "production")
	first := exportResource(t, "shorted-api")
	second := exportResource(t, "shorted-api")
	if first["service.instance.id"] != second["service.instance.id"] {
		t.Fatal("SDK reinitialization must keep the process identity")
	}
	for key, want := range map[string]string{"service.name": "shorted-api", "service.version": "test-sha", "deployment.environment": "production"} {
		if first[key] != want || second[key] != want {
			t.Fatalf("resource attribute %s changed", key)
		}
	}
}

func TestProviderPreservesDefaultEnvironment(t *testing.T) {
	t.Setenv("ENVIRONMENT", "")
	t.Setenv("SERVICE_VERSION", "")
	attrs := exportResource(t, "news-aggregator")
	if attrs["deployment.environment"] != "development" || attrs["service.version"] != "" {
		t.Fatal("default environment/version changed")
	}
}

func TestProviderInstancesDifferAcrossProcesses(t *testing.T) {
	var previous string
	for range 2 {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestProviderIdentityProbe$")
		cmd.Env = append(os.Environ(), "SHORTED_OTEL_IDENTITY_PROBE=1")
		out, err := cmd.CombinedOutput()
		cancel()
		if err != nil {
			t.Fatalf("identity subprocess: %v\n%s", err, out)
		}
		var id string
		for _, line := range strings.Split(string(out), "\n") {
			if strings.HasPrefix(line, "IDENTITY ") {
				id = strings.TrimPrefix(line, "IDENTITY ")
			}
		}
		if _, err := uuid.Parse(id); err != nil {
			t.Fatalf("missing subprocess identity: %s", out)
		}
		if id == previous {
			t.Fatal("independent processes must not share cumulative-counter identity")
		}
		previous = id
	}
}

func TestProviderIdentityProbe(t *testing.T) {
	if os.Getenv("SHORTED_OTEL_IDENTITY_PROBE") != "1" {
		t.Skip("subprocess probe")
	}
	attrs := exportResource(t, "shorted-api")
	fmt.Println("IDENTITY " + attrs["service.instance.id"])
}

func TestProviderDisabledDoesNotInstallExporters(t *testing.T) {
	preserveGlobalProviders(t)
	meter, tracer := metricnoop.NewMeterProvider(), tracenoop.NewTracerProvider()
	otel.SetMeterProvider(meter)
	otel.SetTracerProvider(tracer)
	var calls atomic.Int32
	sink := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { calls.Add(1) }))
	defer sink.Close()
	t.Setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "")
	t.Setenv("OTEL_EXPORTER_OTLP_METRICS_ENDPOINT", sink.URL+"/v1/metrics")
	t.Setenv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", sink.URL+"/v1/traces")
	shutdown, err := InitProvider(context.Background(), "shorted-api")
	if err != nil {
		t.Fatal(err)
	}
	if err := shutdown(context.Background()); err != nil {
		t.Fatal(err)
	}
	if otel.GetMeterProvider() != meter || otel.GetTracerProvider() != tracer || calls.Load() != 0 {
		t.Fatal("disabled OTLP must retain no-op providers and send nothing")
	}
	if SyncStatus == nil {
		t.Fatal("custom metrics must still initialize when OTLP is disabled")
	}
}
