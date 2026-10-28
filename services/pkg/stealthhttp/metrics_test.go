package stealthhttp

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"testing"
	"time"

	"go.opentelemetry.io/otel/attribute"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"
	"go.opentelemetry.io/otel/trace/noop"
)

func TestRecordFetchBoundsHostsBeforeAggregation(t *testing.T) {
	reader := sdkmetric.NewManualReader()
	provider := sdkmetric.NewMeterProvider(sdkmetric.WithReader(reader))
	t.Cleanup(func() { _ = provider.Shutdown(context.Background()) })
	previousTotal, previousErrors, previousBytes, previousDuration := fetchTotal, fetchErrors, fetchBytes, fetchDuration
	t.Cleanup(func() {
		fetchTotal, fetchErrors, fetchBytes, fetchDuration = previousTotal, previousErrors, previousBytes, previousDuration
	})
	m := provider.Meter("shorted.stealthhttp")
	fetchTotal, _ = m.Int64Counter("shorted.stealth.fetch_total")
	fetchErrors, _ = m.Int64Counter("shorted.stealth.fetch_errors")
	fetchBytes, _ = m.Int64Counter("shorted.stealth.fetch_bytes")
	fetchDuration, _ = m.Float64Histogram("shorted.stealth.fetch_duration")
	ctx, span := noop.NewTracerProvider().Tracer("test").Start(context.Background(), "fetch")
	defer span.End()
	client := &Client{engineName: "native"}
	want := map[string]int64{}
	for _, input := range []struct{ url, category string }{
		{"https://WWW.LinkedIn.COM:443/company/aaa", "linkedin.com"},
		{"https://au.linkedin.com./in/example", "linkedin.com"},
		{"https://duckduckgo.com/?q=test", "duckduckgo.com"},
		{"https://query1.finance.yahoo.com:8443/chart", "finance.yahoo.com"},
		{"https://query2.finance.yahoo.com/chart", "finance.yahoo.com"},
		{"https://news.google.com/rss", "news.google.com"},
		{"https://www.asx.com.au/announcements", "asx.com.au"},
		{"https://www.realestate.com.au/property", "realestate.com.au"},
		{"https://www.localgovernment.vic.gov.au/data.xlsx", "localgovernment.vic.gov.au"},
		{"https://discover.data.vic.gov.au/api", "discover.data.vic.gov.au"},
		{"https://www.land.vic.gov.au/data.xlsx", "land.vic.gov.au"},
		{"https://www.valuergeneral.nsw.gov.au/data.zip", "valuergeneral.nsw.gov.au"},
		{"https://www.infrastructure.gov.au/data.xlsx", "infrastructure.gov.au"},
		{"https://notlinkedin.com", "other"},
		{"https://linkedin.com.attacker.test", "other"},
		{"https://linkedin.com@attacker.test", "other"},
		{"https://google.com", "other"},
		{"http://[::1]:1234/logo.png", "other"},
		{"https://%invalid", "other"},
		{"relative/path", "other"},
		{"", "other"},
	} {
		// Recording both outcomes exercises every instrument with the same host
		// categories, not merely a helper which the call site might bypass.
		client.recordFetch(ctx, span, time.Now(), input.url, 200, 7, nil)
		client.recordFetch(ctx, span, time.Now(), input.url, 0, 0, errors.New("fixture"))
		want[input.category]++
	}
	for i := range 100 {
		url := fmt.Sprintf("https://company-%d.example:%d/logo.png", i, 8000+i)
		client.recordFetch(ctx, span, time.Now(), url, 200, 7, nil)
		client.recordFetch(ctx, span, time.Now(), url, 0, 0, errors.New("fixture"))
		want["other"]++
	}
	var result metricdata.ResourceMetrics
	if err := reader.Collect(ctx, &result); err != nil {
		t.Fatal(err)
	}
	checked := 0
	for _, scope := range result.ScopeMetrics {
		for _, metric := range scope.Metrics {
			counts := map[string]int64{}
			multiplier := int64(1)
			wantSeries := len(want)
			switch metric.Name {
			case "shorted.stealth.fetch_total":
				multiplier = 2
				wantSeries *= 2 // The success/error status dimension is retained.
			case "shorted.stealth.fetch_bytes":
				multiplier = 7
			case "shorted.stealth.fetch_duration":
				multiplier = 2
			case "shorted.stealth.fetch_errors":
			default:
				t.Fatalf("unexpected metric %s", metric.Name)
			}
			host := func(attrs attribute.Set) string {
				value, _ := attrs.Value("http.host")
				return value.AsString()
			}
			switch data := metric.Data.(type) {
			case metricdata.Sum[int64]:
				if len(data.DataPoints) != wantSeries {
					t.Errorf("%s exported %d series, want %d", metric.Name, len(data.DataPoints), wantSeries)
				}
				for _, point := range data.DataPoints {
					counts[host(point.Attributes)] += point.Value
				}
			case metricdata.Histogram[float64]:
				if len(data.DataPoints) != wantSeries {
					t.Errorf("%s exported %d series, want %d", metric.Name, len(data.DataPoints), wantSeries)
				}
				for _, point := range data.DataPoints {
					counts[host(point.Attributes)] += int64(point.Count)
				}
			default:
				t.Fatalf("unexpected metric type %T", metric.Data)
			}
			expected := map[string]int64{}
			for host, count := range want {
				expected[host] = count * multiplier
			}
			if !reflect.DeepEqual(counts, expected) {
				t.Errorf("%s: want %d bounded host buckets with all observations, got %d", metric.Name, len(expected), len(counts))
			}
			checked++
		}
	}
	if checked != 4 {
		t.Fatalf("collected %d stealth instruments, want 4", checked)
	}
}
