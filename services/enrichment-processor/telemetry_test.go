package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/castlemilk/shorted.com.au/services/pkg/log"
	shortedotel "github.com/castlemilk/shorted.com.au/services/pkg/otel"
	"go.opentelemetry.io/otel"
	metricsv1 "go.opentelemetry.io/proto/otlp/collector/metrics/v1"
	tracev1 "go.opentelemetry.io/proto/otlp/collector/trace/v1"
	"google.golang.org/protobuf/proto"
)

// Run a real failing process against an in-memory OTLP endpoint. An os.Exit
// inside the batch runner must not skip the deferred flush before it exits.
func TestBatchExportsTelemetryBeforeExit(t *testing.T) {
	for _, outcome := range []string{"failure", "success"} {
		t.Run(outcome, func(t *testing.T) {
			var mu sync.Mutex
			var statuses []string
			var durations uint64
			var lastSuccess int64
			var spans int
			sink := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				body, err := io.ReadAll(r.Body)
				if err != nil {
					t.Errorf("read exporter body: %v", err)
					w.WriteHeader(500)
					return
				}
				mu.Lock()
				defer mu.Unlock()
				switch r.URL.Path {
				case "/v1/metrics":
					var request metricsv1.ExportMetricsServiceRequest
					if err := proto.Unmarshal(body, &request); err != nil {
						t.Errorf("decode metrics: %v", err)
						w.WriteHeader(400)
						return
					}
					for _, resource := range request.ResourceMetrics {
						for _, scope := range resource.ScopeMetrics {
							for _, metric := range scope.Metrics {
								switch metric.Name {
								case "shorted.sync.status":
									for _, point := range metric.GetSum().DataPoints {
										var job, status string
										for _, attr := range point.Attributes {
											switch attr.Key {
											case "sync_job":
												job = attr.Value.GetStringValue()
											case "status":
												status = attr.Value.GetStringValue()
											}
										}
										if job != "enrichment-processor" || point.GetAsInt() != 1 {
											t.Errorf("unexpected batch status point: %v", point)
											continue
										}
										statuses = append(statuses, status)
									}
								case "shorted.sync.duration":
									for _, point := range metric.GetHistogram().DataPoints {
										durations += point.Count
									}
								case "shorted.sync.last_success":
									for _, point := range metric.GetGauge().DataPoints {
										lastSuccess = point.GetAsInt()
									}
								}
							}
						}
					}
				case "/v1/traces":
					var request tracev1.ExportTraceServiceRequest
					if err := proto.Unmarshal(body, &request); err != nil {
						t.Errorf("decode traces: %v", err)
						w.WriteHeader(400)
						return
					}
					for _, resource := range request.ResourceSpans {
						for _, scope := range resource.ScopeSpans {
							for _, span := range scope.Spans {
								if span.Name == "batch.exit.probe" {
									spans++
								}
							}
						}
					}
				default:
					t.Errorf("unexpected export path %s", r.URL.Path)
					w.WriteHeader(404)
					return
				}
				w.Header().Set("Content-Type", "application/x-protobuf")
				w.WriteHeader(http.StatusOK)
			}))
			defer sink.Close()
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			command := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestBatchExitProbe$")
			// Never inherit a production endpoint or credential into the child process.
			for _, entry := range os.Environ() {
				if !strings.HasPrefix(entry, "OTEL_") && !strings.HasPrefix(entry, "SHORTED_BATCH_EXIT_PROBE=") {
					command.Env = append(command.Env, entry)
				}
			}
			command.Env = append(command.Env, "OTEL_EXPORTER_OTLP_ENDPOINT="+sink.URL, "OTEL_TRACES_SAMPLER=always_on", "SHORTED_BATCH_EXIT_PROBE="+outcome)
			output, err := command.CombinedOutput()
			if outcome == "failure" {
				var exit *exec.ExitError
				if !errors.As(err, &exit) || exit.ExitCode() != 1 {
					t.Fatalf("exit=%v, want code 1: %s", err, output)
				}
			} else if err != nil {
				t.Fatalf("success batch failed: %v: %s", err, output)
			}
			mu.Lock()
			defer mu.Unlock()
			if len(statuses) != 1 || statuses[0] != outcome {
				t.Fatalf("exported statuses=%v, want [%s]; process output: %s", statuses, outcome, output)
			}
			if durations != 1 {
				t.Errorf("exported duration count=%d, want 1", durations)
			}
			if spans != 1 {
				t.Errorf("exported spans=%d, want 1", spans)
			}
			if outcome == "failure" && lastSuccess != 0 {
				t.Errorf("failure published last success: %d", lastSuccess)
			}
			if outcome == "success" && lastSuccess == 0 {
				t.Error("success did not publish last success")
			}
		})
	}
}

func TestBatchExitProbe(t *testing.T) {
	outcome := os.Getenv("SHORTED_BATCH_EXIT_PROBE")
	if outcome == "" {
		t.Skip("subprocess probe")
	}
	os.Exit(batchExitProbe(outcome))
}

func batchExitProbe(outcome string) int {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	shutdown, err := shortedotel.InitProvider(ctx, "enrichment-processor")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 2
	}
	defer shutdownTelemetry(shutdown)
	return runBatchWithMetrics(ctx, log.NewLogger(), func(ctx context.Context) error {
		_, span := otel.Tracer("batch-test").Start(ctx, "batch.exit.probe")
		span.End()
		if outcome == "failure" {
			// A failed/canceled job still needs an independent context for shutdown.
			cancel()
			return errors.New("controlled batch failure")
		}
		return nil
	})
}
