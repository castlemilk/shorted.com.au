package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"
)

// This file calls the live Shorts API, read-only, through the same Execute path the
// chat service uses. It is skipped unless CHAT_TOOLS_LIVE=1, and it sends public
// read RPCs only, anonymously. Requests are spaced 1.5s apart, under the anonymous
// edge limit of 10 per 10 seconds. CHAT_TOOLS_LIVE_API_URL overrides the default
// https://api.shorted.com.au.
//
//	CHAT_TOOLS_LIVE=1 GOWORK=off go test -v -count=1 -run TestChatToolsLiveReadOnly ./chat-service/

type liveToolCase struct {
	name string
	tool string
	args map[string]any
	// evidence lists substrings of the result. Any one of them is proof of real data.
	// protojson omits empty fields, so a non-empty value shows up as "key":"...".
	evidence []string
	// allOf lists substrings the result must all contain: the fields the model relies on.
	allOf []string
	// mustFit requires whole JSON that the result budget did not cut. A cut result drops
	// the end of the response, which is where some fields sit.
	mustFit bool
	// minRows requires at least minRows occurrences of rowKey, one per returned row.
	minRows int
	rowKey  string
}

var liveToolCases = []liveToolCase{
	{
		name:     "query_short_positions BHP",
		tool:     "query_short_positions",
		args:     map[string]any{"stock_code": "BHP", "period": "3m"},
		evidence: []string{`"points":[`},
		mustFit:  true,
	},
	{
		name:     "get_top_shorts",
		tool:     "get_top_shorts",
		args:     map[string]any{"limit": 10.0},
		evidence: []string{`"timeSeries":[`},
		mustFit:  true,
		minRows:  10,
		rowKey:   `"productCode":"`,
	},
	{
		// limit 50 is the size the sparkline budget used to cut to 13 rows. Every stock
		// must come back, the lower ones without a sparkline.
		name:     "get_top_shorts 50",
		tool:     "get_top_shorts",
		args:     map[string]any{"limit": 50.0},
		evidence: []string{`"timeSeries":[`},
		mustFit:  true,
		minRows:  50,
		rowKey:   `"productCode":"`,
	},
	{
		name:     "get_stock_details BHP",
		tool:     "get_stock_details",
		args:     map[string]any{"stock_code": "BHP"},
		evidence: []string{`"companyName":"`},
		allOf:    []string{`"marketCap":`, `"companyName":"`},
		mustFit:  true,
	},
	{
		name:     "search_stocks",
		tool:     "search_stocks",
		args:     map[string]any{"query": "commonwealth bank", "limit": 3.0},
		evidence: []string{`"stocks":[`},
	},
	{
		name:     "get_news BHP",
		tool:     "get_news",
		args:     map[string]any{"stock_code": "BHP", "limit": 3.0},
		evidence: []string{`"articles":[`},
	},
	{
		name:     "get_news market",
		tool:     "get_news",
		args:     map[string]any{"limit": 3.0},
		evidence: []string{`"articles":[`},
	},
	{
		name:     "get_director_trades CBA",
		tool:     "get_director_trades",
		args:     map[string]any{"stock_code": "CBA", "limit": 5.0},
		evidence: []string{`"trades":[`},
	},
	{
		name:     "get_peer_comparison BHP",
		tool:     "get_peer_comparison",
		args:     map[string]any{"stock_code": "BHP", "limit": 3.0},
		evidence: []string{`"subject":{`},
	},
	{
		name:     "get_weekly_report latest",
		tool:     "get_weekly_report",
		args:     map[string]any{},
		evidence: []string{`"weekSlug":"`},
		allOf:    []string{`"fallers":[`, `"industryBreakdown":[`, `"narrative":{`},
		mustFit:  true,
	},
	{
		name:     "get_related_news BHP",
		tool:     "get_related_news",
		args:     map[string]any{"stock_code": "BHP", "limit": 3.0},
		evidence: []string{`"articles":[`},
		mustFit:  true,
	},
	{
		name:     "get_stock_graph BHP",
		tool:     "get_stock_graph",
		args:     map[string]any{"stock_code": "BHP", "limit": 5.0},
		evidence: []string{`"people":[`, `"similarCompanies":[`},
	},
	{
		name:     "get_event_timeline BHP",
		tool:     "get_event_timeline",
		args:     map[string]any{"stock_code": "BHP", "days_back": 90.0, "limit": 10.0},
		evidence: []string{`"events":[`},
	},
	{
		// limit 10 is the size whose raw response, 32.9 KB, the budget used to cut. The
		// shaper writes an empty list as [], so the evidence is the opening of an item.
		name:     "get_stock_signals CBA",
		tool:     "get_stock_signals",
		args:     map[string]any{"stock_code": "CBA", "limit": 10.0},
		evidence: []string{`"adverse":[{`, `"positive":[{`},
		mustFit:  true,
	},
	{
		name:     "get_economic_series cash rate",
		tool:     "get_economic_series",
		args:     map[string]any{"series_keys": []any{"rates.cash_rate_target.aus"}, "limit": 3.0},
		evidence: []string{`"key":"rates.cash_rate_target.aus"`},
	},
}

func TestChatToolsLiveReadOnly(t *testing.T) {
	if os.Getenv("CHAT_TOOLS_LIVE") != "1" {
		t.Skip("set CHAT_TOOLS_LIVE=1 to call the live Shorts API (read-only)")
	}
	base := os.Getenv("CHAT_TOOLS_LIVE_API_URL")
	if base == "" {
		base = "https://api.shorted.com.au"
	}

	executor := NewToolExecutor(base)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	for i, tc := range liveToolCases {
		if i > 0 {
			time.Sleep(1500 * time.Millisecond)
		}

		result, err := executor.Execute(ctx, tc.tool, tc.args)
		status := http.StatusOK
		if err != nil {
			status = 0
			if apiErr, ok := errors.AsType[*rpcError](err); ok {
				status = apiErr.statusCode
			}
		}
		hasData := err == nil && containsAny(result, tc.evidence)
		t.Logf("%-30s status=%d data=%v bytes=%d", tc.name, status, hasData, len(result))

		if err != nil {
			t.Errorf("%s: %v", tc.name, err)
			continue
		}
		if !hasData {
			t.Errorf("%s: result has none of %q: %.200s", tc.name, tc.evidence, result)
		}
		for _, want := range tc.allOf {
			if !strings.Contains(result, want) {
				t.Errorf("%s: result lacks %s", tc.name, want)
			}
		}
		if tc.mustFit {
			if strings.HasSuffix(result, "...(truncated)") {
				t.Errorf("%s: result was cut at the budget, so the model does not see its end", tc.name)
			}
			if !json.Valid([]byte(result)) {
				t.Errorf("%s: result is not valid JSON: %.200s", tc.name, result)
			}
		}
		if tc.minRows > 0 {
			if rows := strings.Count(result, tc.rowKey); rows < tc.minRows {
				t.Errorf("%s: %d rows of %s, want at least %d", tc.name, rows, tc.rowKey, tc.minRows)
			}
		}
	}
}

func containsAny(s string, substrings []string) bool {
	for _, sub := range substrings {
		if strings.Contains(s, sub) {
			return true
		}
	}
	return false
}
