package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestExecuteEconomicSeriesValidatesSeriesKeys(t *testing.T) {
	tests := []struct {
		name string
		args map[string]interface{}
		want string
	}{
		{name: "missing", args: map[string]interface{}{}, want: "series_keys"},
		{name: "empty array", args: map[string]interface{}{"series_keys": []interface{}{}}, want: "series_keys"},
		{name: "empty key", args: map[string]interface{}{"series_keys": []interface{}{"	"}}, want: "series_keys"},
		{name: "too many", args: map[string]interface{}{"series_keys": []string{"1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11"}}, want: "at most 10"},
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
	observations := make([]map[string]interface{}, 14)
	for i := range observations {
		observations[i] = map[string]interface{}{
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

		var request map[string]interface{}
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		if len(request) != 1 {
			t.Errorf("request body = %#v, want only seriesKeys", request)
		}
		keys, ok := request["seriesKeys"].([]interface{})
		if !ok || len(keys) != 2 || keys[0] != "rates.cash_rate_target.aus" || keys[1] != "cpi.annual_change.all_groups.aus" {
			t.Errorf("seriesKeys = %#v, want requested keys", request["seriesKeys"])
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"series": []interface{}{
				map[string]interface{}{
					"info": map[string]interface{}{
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

	result, err := executor.Execute(context.Background(), "get_economic_series", map[string]interface{}{
		"series_keys": []interface{}{"rates.cash_rate_target.aus", "cpi.annual_change.all_groups.aus"},
	})
	if err != nil {
		t.Fatalf("Execute() error = %v", err)
	}

	var output struct {
		Series []struct {
			Key          string                   `json:"key"`
			Name         string                   `json:"name"`
			Unit         string                   `json:"unit"`
			Frequency    string                   `json:"frequency"`
			Observations []map[string]interface{} `json:"observations"`
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

	var rawOutput map[string]interface{}
	if err := json.Unmarshal([]byte(result), &rawOutput); err != nil {
		t.Fatal(err)
	}
	rawSeries := rawOutput["series"].([]interface{})[0].(map[string]interface{})
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
		map[string]interface{}{"seriesKeys": []string{"rates.cash_rate_target.aus"}},
	)
	if err != nil {
		t.Fatalf("callServiceRPC() error = %v", err)
	}
	if got, want := string(body), `{"series":[]}`; got != want {
		t.Fatalf("body = %q, want %q", got, want)
	}
}

func TestExecuteEconomicSeriesNormalizesLimit(t *testing.T) {
	observations := make([]map[string]interface{}, 65)
	for i := range observations {
		observations[i] = map[string]interface{}{"period": fmt.Sprintf("p%02d", i), "value": i}
	}
	executor := newTestToolExecutor(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"series": []interface{}{map[string]interface{}{
				"info": map[string]interface{}{
					"seriesKey": "cpi.annual_change.all_groups.aus", "regionName": "Australia", "unit": "percent", "frequency": "quarterly",
				},
				"observations": observations,
			}},
		})
	}))

	tests := []struct {
		name      string
		limit     interface{}
		wantCount int
		wantFirst string
	}{
		{name: "clamps JSON number above maximum", limit: float64(100), wantCount: 60, wantFirst: "p05"},
		{name: "uses default for non-positive generic number", limit: -1, wantCount: 12, wantFirst: "p53"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			result, err := executor.Execute(context.Background(), "get_economic_series", map[string]interface{}{
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
