package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// ToolExecutor calls the Shorts API to execute tool functions.
type ToolExecutor struct {
	shortsAPIURL string
	httpClient   *http.Client
}

// NewToolExecutor creates a new tool executor.
func NewToolExecutor(shortsAPIURL string) *ToolExecutor {
	return &ToolExecutor{
		shortsAPIURL: strings.TrimRight(shortsAPIURL, "/"),
		httpClient: &http.Client{
			Timeout: 30 * time.Second,
		},
	}
}

// Execute runs a tool and returns the JSON result.
func (te *ToolExecutor) Execute(ctx context.Context, toolName string, args map[string]interface{}) (string, error) {
	switch toolName {
	case "query_short_positions":
		return te.callRPC(ctx, "GetStockData", args)
	case "get_top_shorts":
		return te.callRPC(ctx, "GetTopShorts", args)
	case "get_stock_details":
		return te.callRPC(ctx, "GetStockDetails", args)
	case "search_stocks":
		return te.callRPC(ctx, "SearchStocks", args)
	case "get_news":
		if _, ok := args["stock_code"]; ok {
			return te.callRPC(ctx, "GetStockNews", args)
		}
		return te.callRPC(ctx, "GetMarketNews", args)
	case "get_director_trades":
		return te.callRPC(ctx, "GetDirectorTrades", args)
	case "get_peer_comparison":
		return te.callRPC(ctx, "GetPeerComparison", args)
	case "get_weekly_report":
		return te.callRPC(ctx, "GetWeeklyReport", args)
	case "get_related_news":
		return te.callRPC(ctx, "GetRelatedNews", args)
	case "get_stock_graph":
		return te.callRPC(ctx, "GetStockGraph", args)
	case "get_event_timeline":
		return te.callRPC(ctx, "GetEventTimeline", args)
	case "get_stock_signals":
		return te.callRPC(ctx, "GetStockSignals", args)
	default:
		return "", fmt.Errorf("unknown tool: %s", toolName)
	}
}

// callRPC makes a Connect-RPC call to the Shorts API.
func (te *ToolExecutor) callRPC(ctx context.Context, method string, args map[string]interface{}) (string, error) {
	// Map tool args to RPC request format
	reqBody := mapArgsToRequest(method, args)

	bodyBytes, err := json.Marshal(reqBody)
	if err != nil {
		return "", fmt.Errorf("marshal request: %w", err)
	}

	url := fmt.Sprintf("%s/shorts.v1alpha1.ShortedStocksService/%s", te.shortsAPIURL, method)
	req, err := http.NewRequestWithContext(ctx, "POST", url, bytes.NewReader(bodyBytes))
	if err != nil {
		return "", fmt.Errorf("create request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := te.httpClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("execute request: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", fmt.Errorf("read response: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("RPC %s returned %d: %s", method, resp.StatusCode, string(respBody))
	}

	// Truncate very large responses to avoid exceeding LLM context
	result := string(respBody)
	if len(result) > 8000 {
		result = result[:8000] + "...(truncated)"
	}

	return result, nil
}

// mapArgsToRequest converts tool arguments to the RPC request format.
func mapArgsToRequest(method string, args map[string]interface{}) map[string]interface{} {
	req := make(map[string]interface{})

	switch method {
	case "GetStockData":
		if v, ok := args["stock_code"]; ok {
			req["productCode"] = v
		}
		if v, ok := args["period"]; ok {
			req["period"] = v
		}
	case "GetTopShorts":
		if v, ok := args["limit"]; ok {
			req["limit"] = v
		}
		if v, ok := args["period"]; ok {
			req["period"] = v
		} else {
			req["period"] = "3m"
		}
	case "GetStockDetails":
		if v, ok := args["stock_code"]; ok {
			req["stockCode"] = v
		}
	case "SearchStocks":
		if v, ok := args["query"]; ok {
			req["query"] = v
		}
		if v, ok := args["limit"]; ok {
			req["limit"] = v
		}
	case "GetStockNews":
		if v, ok := args["stock_code"]; ok {
			req["stockCode"] = v
		}
		if v, ok := args["limit"]; ok {
			req["limit"] = v
		}
	case "GetMarketNews":
		if v, ok := args["limit"]; ok {
			req["limit"] = v
		}
	case "GetDirectorTrades":
		if v, ok := args["stock_code"]; ok {
			req["stockCode"] = v
		}
		if v, ok := args["limit"]; ok {
			req["limit"] = v
		}
	case "GetPeerComparison":
		if v, ok := args["stock_code"]; ok {
			req["stockCode"] = v
		}
		if v, ok := args["limit"]; ok {
			req["limit"] = v
		}
	case "GetWeeklyReport":
		if v, ok := args["week"]; ok {
			req["weekSlug"] = v
		}
	case "GetRelatedNews":
		if v, ok := args["stock_code"]; ok {
			req["stockCode"] = v
		}
		if v, ok := args["article_id"]; ok {
			req["articleId"] = v
		}
		if v, ok := args["limit"]; ok {
			req["limit"] = v
		} else {
			req["limit"] = 5
		}
	case "GetStockGraph":
		if v, ok := args["stock_code"]; ok {
			req["stockCode"] = v
		}
		if v, ok := args["limit"]; ok {
			req["limit"] = v
		} else {
			req["limit"] = 10
		}
	case "GetEventTimeline":
		if v, ok := args["stock_code"]; ok {
			req["stockCode"] = v
		}
		if v, ok := args["days_back"]; ok {
			req["daysBack"] = v
		} else {
			req["daysBack"] = 90
		}
		if v, ok := args["limit"]; ok {
			req["limit"] = v
		} else {
			req["limit"] = 20
		}
	case "GetStockSignals":
		if v, ok := args["stock_code"]; ok {
			req["stockCode"] = v
		}
		if v, ok := args["limit"]; ok {
			req["limit"] = v
		} else {
			req["limit"] = 10
		}
	}

	return req
}
