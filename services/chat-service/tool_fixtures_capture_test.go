package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// captureToolFixture is one live tool call. Its exact result string is saved as a UI
// fixture: the bytes written are the string Execute returns, with no wrapper.
type captureToolFixture struct {
	file string
	tool string
	args map[string]any
}

var captureToolFixtures = []captureToolFixture{
	{file: "get_top_shorts-10.json", tool: "get_top_shorts", args: map[string]any{"limit": 10.0}},
	{file: "get_top_shorts-50.json", tool: "get_top_shorts", args: map[string]any{"limit": 50.0}},
	{file: "query_short_positions-bhp-1y.json", tool: "query_short_positions", args: map[string]any{"stock_code": "BHP", "period": "1y"}},
	{file: "query_short_positions-dro-6m.json", tool: "query_short_positions", args: map[string]any{"stock_code": "DRO", "period": "6m"}},
	// GLC has four observations in the 3m window: a short series for the chart's edge case.
	{file: "query_short_positions-glc-3m.json", tool: "query_short_positions", args: map[string]any{"stock_code": "GLC", "period": "3m"}},
	{file: "get_peer_comparison-bhp.json", tool: "get_peer_comparison", args: map[string]any{"stock_code": "BHP"}},
	{file: "get_director_trades-bhp.json", tool: "get_director_trades", args: map[string]any{"stock_code": "BHP", "limit": 10.0}},
	// At the tool's 50-row limit BHP has 44 trades, more than the budget holds: the answer the table must trim.
	{file: "get_director_trades-bhp-50.json", tool: "get_director_trades", args: map[string]any{"stock_code": "BHP", "limit": 50.0}},
	// GLC has no director trades on the ASX feed: the empty answer the table must handle.
	{file: "get_director_trades-glc-none.json", tool: "get_director_trades", args: map[string]any{"stock_code": "GLC", "limit": 10.0}},
	{file: "get_stock_details-bhp.json", tool: "get_stock_details", args: map[string]any{"stock_code": "BHP"}},
	{file: "get_economic_series-cash-rate-cpi.json", tool: "get_economic_series", args: map[string]any{"series_keys": []any{"rates.cash_rate_target.aus", "cpi.annual_change.all_groups.aus"}}},
	{file: "get_economic_series-unemployment-nsw.json", tool: "get_economic_series", args: map[string]any{"series_keys": []any{"labour.unemployment_rate.total.nsw.seasadj"}, "limit": 24.0}},
}

// TestCaptureToolResultFixtures records the exact result strings the chat tools return
// for real stocks, read-only, through the same Execute path the chat service uses.
// It is skipped unless CHAT_TOOLS_CAPTURE_FIXTURES names an existing output directory.
// Requests are spaced 1.5s apart, under the anonymous edge limit. CHAT_TOOLS_LIVE_API_URL
// overrides https://api.shorted.com.au, as it does for TestChatToolsLiveReadOnly.
// CHAT_TOOLS_CAPTURE_ONLY, a comma-separated list of file names, records only those cases.
//
//	CHAT_TOOLS_CAPTURE_FIXTURES=/abs/path/web/src/@/components/chat/__fixtures__/tool-results \
//	  GOWORK=off go test -count=1 -run TestCaptureToolResultFixtures ./chat-service/
func TestCaptureToolResultFixtures(t *testing.T) {
	dir := os.Getenv("CHAT_TOOLS_CAPTURE_FIXTURES")
	if dir == "" {
		t.Skip("set CHAT_TOOLS_CAPTURE_FIXTURES to an existing directory to record live tool results (read-only)")
	}
	if info, err := os.Stat(dir); err != nil || !info.IsDir() {
		t.Fatalf("CHAT_TOOLS_CAPTURE_FIXTURES %q must be an existing directory", dir)
	}
	base := os.Getenv("CHAT_TOOLS_LIVE_API_URL")
	if base == "" {
		base = "https://api.shorted.com.au"
	}
	cases := selectCaptureCases(t, os.Getenv("CHAT_TOOLS_CAPTURE_ONLY"))

	executor := NewToolExecutor(base)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	for i, tc := range cases {
		if i > 0 {
			time.Sleep(1500 * time.Millisecond)
		}

		result, err := executor.Execute(ctx, tc.tool, tc.args)
		if err != nil {
			t.Errorf("%s: %v", tc.file, err)
			continue
		}
		// A fixture must be the whole response the model sees. A cut result is not one.
		if strings.HasSuffix(result, "...(truncated)") || !json.Valid([]byte(result)) {
			t.Errorf("%s: result is cut or not valid JSON (%d bytes)", tc.file, len(result))
			continue
		}
		if err := os.WriteFile(filepath.Join(dir, tc.file), []byte(result), 0o644); err != nil {
			t.Errorf("%s: write: %v", tc.file, err)
			continue
		}
		t.Logf("%-42s bytes=%d", tc.file, len(result))
	}
}

// selectCaptureCases returns every capture case, or only the ones named in only, a
// comma-separated list of fixture file names. Naming one tool's files re-records just
// those, so the other fixtures keep the values they were recorded with. An unknown name
// fails the test rather than being skipped.
func selectCaptureCases(t *testing.T, only string) []captureToolFixture {
	t.Helper()
	wanted := map[string]bool{}
	for name := range strings.SplitSeq(only, ",") {
		if name = strings.TrimSpace(name); name != "" {
			wanted[name] = true
		}
	}
	if len(wanted) == 0 {
		return captureToolFixtures
	}
	var cases []captureToolFixture
	for _, tc := range captureToolFixtures {
		if wanted[tc.file] {
			cases = append(cases, tc)
			delete(wanted, tc.file)
		}
	}
	for name := range wanted {
		t.Fatalf("CHAT_TOOLS_CAPTURE_ONLY names %q, which is not a capture case", name)
	}
	return cases
}
