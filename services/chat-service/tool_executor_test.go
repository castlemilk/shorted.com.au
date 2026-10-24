package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"connectrpc.com/connect"
	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	"github.com/castlemilk/shorted.com.au/services/pkg/ratelimit"
)

func TestExecuteEconomicSeriesValidatesSeriesKeys(t *testing.T) {
	tests := []struct {
		name string
		args map[string]any
		want string
	}{
		{name: "missing", args: map[string]any{}, want: "series_keys"},
		{name: "empty array", args: map[string]any{"series_keys": []any{}}, want: "series_keys"},
		{name: "empty key", args: map[string]any{"series_keys": []any{"	"}}, want: "series_keys"},
		{name: "too many", args: map[string]any{"series_keys": []string{"1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11"}}, want: "at most 10"},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			executor := NewToolExecutor("http://unused.invalid")
			_, err := executor.Execute(context.Background(), "get_economic_series", test.args)
			if err == nil {
				t.Fatal("Execute() error = nil, want validation error")
			}
			if !strings.Contains(err.Error(), test.want) {
				t.Fatalf("Execute() error = %q, want it to contain %q", err, test.want)
			}
		})
	}
}

func TestExecuteEconomicSeriesPostsConnectJSONAndReturnsTrimmedSeries(t *testing.T) {
	observations := make([]map[string]any, 14)
	for i := range observations {
		observations[i] = map[string]any{
			"period": fmt.Sprintf("2025-%02d-01T00:00:00Z", i+1),
			"value":  float64(i),
			"note":   "must not leak",
		}
	}

	executor := newTestToolExecutor(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Errorf("method = %s, want POST", r.Method)
		}
		if r.URL.Path != "/shorts.v1alpha1.EconomyService/GetEconomicSeries" {
			t.Errorf("path = %q, want EconomyService/GetEconomicSeries", r.URL.Path)
		}
		if got := r.Header.Get("Content-Type"); got != "application/json" {
			t.Errorf("Content-Type = %q, want application/json", got)
		}

		var request map[string]any
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		if len(request) != 2 {
			t.Errorf("request body = %#v, want seriesKeys and maxObservations", request)
		}
		keys, ok := request["seriesKeys"].([]any)
		if !ok || len(keys) != 2 || keys[0] != "rates.cash_rate_target.aus" || keys[1] != "cpi.annual_change.all_groups.aus" {
			t.Errorf("seriesKeys = %#v, want requested keys", request["seriesKeys"])
		}
		if got := request["maxObservations"]; got != float64(12) {
			t.Errorf("maxObservations = %#v, want default limit 12", got)
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"series": []any{
				map[string]any{
					"info": map[string]any{
						"seriesKey":     "rates.cash_rate_target.aus",
						"regionName":    "Australia",
						"unit":          "percent",
						"frequency":     "monthly",
						"sourceKey":     "rba",
						"sourceLicence": "CC BY",
					},
					"observations": observations,
				},
			},
		})
	}))

	result, err := executor.Execute(context.Background(), "get_economic_series", map[string]any{
		"series_keys": []any{"rates.cash_rate_target.aus", "cpi.annual_change.all_groups.aus"},
	})
	if err != nil {
		t.Fatalf("Execute() error = %v", err)
	}

	var output struct {
		Series []struct {
			Key          string           `json:"key"`
			Name         string           `json:"name"`
			Unit         string           `json:"unit"`
			Frequency    string           `json:"frequency"`
			Observations []map[string]any `json:"observations"`
		} `json:"series"`
	}
	if err := json.Unmarshal([]byte(result), &output); err != nil {
		t.Fatalf("result is not JSON: %v\n%s", err, result)
	}
	if len(output.Series) != 1 {
		t.Fatalf("series count = %d, want 1", len(output.Series))
	}
	series := output.Series[0]
	if series.Key != "rates.cash_rate_target.aus" || series.Name != "Australia" || series.Unit != "percent" || series.Frequency != "monthly" {
		t.Errorf("series metadata = %#v, want selected info fields", series)
	}
	if len(series.Observations) != 12 {
		t.Fatalf("observations count = %d, want default limit 12", len(series.Observations))
	}
	if got := series.Observations[0]["value"]; got != float64(2) {
		t.Errorf("first observation value = %v, want 2 (last 12 observations)", got)
	}
	if got := series.Observations[11]["value"]; got != float64(13) {
		t.Errorf("last observation value = %v, want 13", got)
	}
	for _, observation := range series.Observations {
		if len(observation) != 2 {
			t.Errorf("observation = %#v, want only period and value", observation)
		}
	}

	var rawOutput map[string]any
	if err := json.Unmarshal([]byte(result), &rawOutput); err != nil {
		t.Fatal(err)
	}
	rawSeries := rawOutput["series"].([]any)[0].(map[string]any)
	if len(rawSeries) != 5 {
		t.Errorf("series output fields = %#v, want only key, name, unit, frequency, observations", rawSeries)
	}
}

func TestCallServiceRPCPostsToRequestedServiceAndMethod(t *testing.T) {
	executor := newTestToolExecutor(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got, want := r.URL.Path, "/shorts.v1alpha1.EconomyService/GetEconomicSeries"; got != want {
			t.Errorf("path = %q, want %q", got, want)
		}
		if got := r.Header.Get("Content-Type"); got != "application/json" {
			t.Errorf("Content-Type = %q, want application/json", got)
		}
		_, _ = w.Write([]byte(`{"series":[]}`))
	}))

	body, err := executor.callServiceRPC(
		context.Background(),
		"EconomyService",
		"GetEconomicSeries",
		&shortsv1alpha1.GetEconomicSeriesRequest{SeriesKeys: []string{"rates.cash_rate_target.aus"}},
	)
	if err != nil {
		t.Fatalf("callServiceRPC() error = %v", err)
	}
	if got, want := string(body), `{"series":[]}`; got != want {
		t.Fatalf("body = %q, want %q", got, want)
	}
}

// TestGetStockDetailsSendsUserAgentTheShortsAPIAccepts is the regression test for
// chat tools failing with 403 "automated access detected": the API rejected Go's
// default User-Agent, so the tool call must send toolUserAgent instead.
func TestGetStockDetailsSendsUserAgentTheShortsAPIAccepts(t *testing.T) {
	executor := newTestToolExecutor(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got, want := r.URL.Path, "/shorts.v1alpha1.ShortedStocksService/GetStockDetails"; got != want {
			t.Errorf("path = %q, want %q", got, want)
		}
		if got := r.Header.Get("Content-Type"); got != "application/json" {
			t.Errorf("Content-Type = %q, want application/json", got)
		}
		if got := r.Header.Get("User-Agent"); got != toolUserAgent {
			t.Errorf("User-Agent = %q, want %q", got, toolUserAgent)
		}
		if err := apiScraperFilter(r.Header.Get("User-Agent")); err != nil {
			t.Errorf("Shorts API rejects the chat tool User-Agent: %v", err)
		}
		_, _ = w.Write([]byte(`{"stock":{}}`))
	}))

	if _, err := executor.Execute(context.Background(), "get_stock_details", map[string]any{"stock_code": "BHP"}); err != nil {
		t.Fatalf("Execute() error = %v", err)
	}
}

// TestAPIScraperFilterAllowsToolUserAgentAndBlocksGoDefault checks the constant
// against the API's real blocklist, and that the Go default is blocked so the
// first test proves the mechanism rather than passing vacuously.
func TestAPIScraperFilterAllowsToolUserAgentAndBlocksGoDefault(t *testing.T) {
	if err := apiScraperFilter(toolUserAgent); err != nil {
		t.Errorf("API blocks toolUserAgent %q: %v", toolUserAgent, err)
	}
	if err := apiScraperFilter("Go-http-client/1.1"); connect.CodeOf(err) != connect.CodePermissionDenied {
		t.Errorf("API on Go default User-Agent: code = %v, want %v", connect.CodeOf(err), connect.CodePermissionDenied)
	}
}

// apiScraperFilter sends an unauthenticated call with the given User-Agent through
// the Shorts API's own UserAgentInterceptor and returns its verdict.
func apiScraperFilter(userAgent string) error {
	type claimsKey struct{}
	next := func(context.Context, connect.AnyRequest) (connect.AnyResponse, error) {
		return connect.NewResponse(new(string)), nil
	}
	req := connect.NewRequest(new(string))
	req.Header().Set("User-Agent", userAgent)
	_, err := ratelimit.UserAgentInterceptor(claimsKey{})(next)(context.Background(), req)
	return err
}

func TestExecuteEconomicSeriesNormalizesLimit(t *testing.T) {
	observations := make([]map[string]any, 65)
	for i := range observations {
		observations[i] = map[string]any{"period": fmt.Sprintf("p%02d", i), "value": i}
	}

	tests := []struct {
		name      string
		limit     any
		wantCount int
		wantFirst string
	}{
		{name: "clamps JSON number above maximum", limit: float64(100), wantCount: 60, wantFirst: "p05"},
		{name: "uses default for non-positive generic number", limit: -1, wantCount: 12, wantFirst: "p53"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			executor := newTestToolExecutor(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var request map[string]any
				if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
					t.Fatalf("decode request: %v", err)
				}
				if got := request["maxObservations"]; got != float64(test.wantCount) {
					t.Errorf("maxObservations = %#v, want %d", got, test.wantCount)
				}
				_ = json.NewEncoder(w).Encode(map[string]any{
					"series": []any{map[string]any{
						"info": map[string]any{
							"seriesKey": "cpi.annual_change.all_groups.aus", "regionName": "Australia", "unit": "percent", "frequency": "quarterly",
						},
						"observations": observations,
					}},
				})
			}))
			result, err := executor.Execute(context.Background(), "get_economic_series", map[string]any{
				"series_keys": []string{"cpi.annual_change.all_groups.aus"},
				"limit":       test.limit,
			})
			if err != nil {
				t.Fatalf("Execute() error = %v", err)
			}
			var output struct {
				Series []struct {
					Observations []struct {
						Period string `json:"period"`
					} `json:"observations"`
				} `json:"series"`
			}
			if err := json.Unmarshal([]byte(result), &output); err != nil {
				t.Fatalf("unmarshal result: %v", err)
			}
			got := output.Series[0].Observations
			if len(got) != test.wantCount {
				t.Fatalf("observation count = %d, want %d", len(got), test.wantCount)
			}
			if got[0].Period != test.wantFirst {
				t.Errorf("first period = %q, want %q", got[0].Period, test.wantFirst)
			}
		})
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (fn roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return fn(request)
}

func newTestToolExecutor(handler http.Handler) *ToolExecutor {
	executor := NewToolExecutor("https://shorts.test/")
	executor.httpClient = &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, request)
		return recorder.Result(), nil
	})}
	return executor
}

func TestExecuteAnswerWithoutDataReturnsItsFixedResultWithNoRequest(t *testing.T) {
	executor := newTestToolExecutor(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Errorf("answer_without_data made a request to %s", r.URL.Path)
		w.WriteHeader(http.StatusInternalServerError)
	}))

	got, err := executor.Execute(context.Background(), answerWithoutDataTool, nil)
	if err != nil {
		t.Fatalf("Execute() error = %v", err)
	}
	if got != answerWithoutDataResult {
		t.Fatalf("Execute() = %q, want the fixed result %q", got, answerWithoutDataResult)
	}
	if !json.Valid([]byte(got)) {
		t.Fatalf("fixed result %q is not JSON", got)
	}
}
