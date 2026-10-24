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

	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"

	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
)

// toolUserAgent is sent on every Shorts API call made for a chat tool. The API's
// UserAgentInterceptor blocks Go's default "Go-http-client/1.1" as a scraper
// (services/pkg/ratelimit/useragent.go), which silently failed every tool call.
const toolUserAgent = "shorted-chat-service/1.0 (+https://shorted.com.au)"

// maxToolResultBytes bounds a tool result so one response cannot exhaust the LLM
// context. Longer results are cut and marked.
const maxToolResultBytes = 8000

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
func (te *ToolExecutor) Execute(ctx context.Context, toolName string, args map[string]any) (string, error) {
	// answer_without_data makes no request. Its result is fixed, so it returns at once.
	if toolName == answerWithoutDataTool {
		return answerWithoutDataResult, nil
	}

	call, err := buildToolCall(toolName, args)
	if err != nil {
		return "", err
	}

	// get_weekly_report without a week means the latest report, but the API
	// requires a week_slug. The newest weekly slug is looked up first.
	if request, ok := call.request.(*shortsv1alpha1.GetWeeklyReportRequest); ok && request.WeekSlug == "" {
		slug, err := te.latestReportSlug(ctx, "weekly")
		if err != nil {
			return "", err
		}
		request.WeekSlug = slug
	}

	respBody, err := te.callServiceRPC(ctx, call.service, call.method, call.request)
	if err != nil {
		return "", err
	}

	// Each response is shaped to what the model needs before the budget applies. Cutting
	// the raw body would drop the fields that come last, such as market cap or the
	// weekly movers.
	switch request := call.request.(type) {
	case *shortsv1alpha1.GetEconomicSeriesRequest:
		return summarizeEconomicSeries(respBody, int(request.GetMaxObservations()))
	case *shortsv1alpha1.GetStockDetailsRequest:
		result, err := summarizeStockDetails(respBody)
		if err != nil {
			return "", err
		}
		return truncateToolResult(result), nil
	case *shortsv1alpha1.GetWeeklyReportRequest:
		result, err := summarizeWeeklyReport(respBody)
		if err != nil {
			return "", err
		}
		return truncateToolResultTo(result, maxWeeklyReportBytes), nil
	// The next three budget their own rows or items, so their output is valid JSON under
	// maxToolResultBytes and is not cut here.
	case *shortsv1alpha1.GetTopShortsRequest:
		return summarizeTopShorts(respBody)
	case *shortsv1alpha1.GetStockSignalsRequest:
		return summarizeStockSignals(respBody)
	case *shortsv1alpha1.GetDirectorTradesRequest:
		return summarizeDirectorTrades(respBody)
	}
	return truncateToolResult(string(respBody)), nil
}

// latestReportSlug returns the slug of the newest published report of a type.
// ListReports returns the newest first, so a limit of 1 is the latest report.
func (te *ToolExecutor) latestReportSlug(ctx context.Context, reportType string) (string, error) {
	body, err := te.callServiceRPC(ctx, legacyShortsService, "ListReports", &shortsv1alpha1.ListReportsRequest{
		ReportType: reportType,
		Limit:      1,
	})
	if err != nil {
		return "", err
	}

	var response shortsv1alpha1.ListReportsResponse
	if err := (protojson.UnmarshalOptions{DiscardUnknown: true}).Unmarshal(body, &response); err != nil {
		return "", fmt.Errorf("decode ListReports response: %w", err)
	}
	if len(response.Reports) == 0 || response.Reports[0].GetSlug() == "" {
		return "", fmt.Errorf("no published %s report", reportType)
	}
	return response.Reports[0].GetSlug(), nil
}

// truncateToolResult cuts a result that would exceed the LLM context budget.
func truncateToolResult(result string) string {
	return truncateToolResultTo(result, maxToolResultBytes)
}

// truncateToolResultTo cuts a result longer than limit bytes and marks the cut.
func truncateToolResultTo(result string, limit int) string {
	if len(result) > limit {
		return result[:limit] + "...(truncated)"
	}
	return result
}

// summarizeEconomicSeries keeps the key metadata and the most recent limit
// observations of each series, dropping the rest of the API response.
func summarizeEconomicSeries(respBody []byte, limit int) (string, error) {
	var apiResponse economicSeriesAPIResponse
	if err := json.Unmarshal(respBody, &apiResponse); err != nil {
		return "", fmt.Errorf("decode GetEconomicSeries response: %w", err)
	}

	result := economicSeriesResult{Series: make([]economicSeriesResultItem, 0, len(apiResponse.Series))}
	for _, series := range apiResponse.Series {
		observations := series.Observations
		if len(observations) > limit {
			observations = observations[len(observations)-limit:]
		}
		result.Series = append(result.Series, economicSeriesResultItem{
			Key:          series.Info.SeriesKey,
			Name:         series.Info.RegionName,
			Unit:         series.Info.Unit,
			Frequency:    series.Info.Frequency,
			Observations: observations,
		})
	}

	resultBytes, err := json.Marshal(result)
	if err != nil {
		return "", fmt.Errorf("marshal GetEconomicSeries result: %w", err)
	}
	return string(resultBytes), nil
}

// The economic series response is decoded with encoding/json into these shapes
// rather than the generated types, so unknown fields are ignored. The JSON names
// are checked against the generated descriptors by the contract test.
type economicSeriesAPIResponse struct {
	Series []struct {
		Info struct {
			SeriesKey  string `json:"seriesKey"`
			RegionName string `json:"regionName"`
			Unit       string `json:"unit"`
			Frequency  string `json:"frequency"`
		} `json:"info"`
		Observations []economicSeriesObservation `json:"observations"`
	} `json:"series"`
}

type economicSeriesObservation struct {
	Period string  `json:"period"`
	Value  float64 `json:"value"`
}

type economicSeriesResult struct {
	Series []economicSeriesResultItem `json:"series"`
}

type economicSeriesResultItem struct {
	Key          string                      `json:"key"`
	Name         string                      `json:"name"`
	Unit         string                      `json:"unit"`
	Frequency    string                      `json:"frequency"`
	Observations []economicSeriesObservation `json:"observations"`
}

// rpcError is a non-200 answer from the Shorts API. Error() keeps the text the chat
// tools have always returned to the model. The status code lets a caller tell an
// API refusal from a transport failure.
type rpcError struct {
	method     string
	statusCode int
	body       string
}

func (e *rpcError) Error() string {
	return fmt.Sprintf("RPC %s returned %d: %s", e.method, e.statusCode, e.body)
}

// callServiceRPC sends a request message to a service method as Connect JSON and
// returns the complete response body. Tool-specific shaping and truncation stay
// with the caller; HTTP behavior is shared by every tool.
func (te *ToolExecutor) callServiceRPC(
	ctx context.Context,
	service string,
	method string,
	request proto.Message,
) ([]byte, error) {
	bodyBytes, err := protojson.Marshal(request)
	if err != nil {
		return nil, fmt.Errorf("marshal %s request: %w", method, err)
	}

	url := fmt.Sprintf("%s/shorts.v1alpha1.%s/%s", te.shortsAPIURL, service, method)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(bodyBytes))
	if err != nil {
		return nil, fmt.Errorf("create request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", toolUserAgent)

	resp, err := te.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("execute request: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("read response: %w", err)
	}
	if resp.StatusCode != http.StatusOK {
		return nil, &rpcError{method: method, statusCode: resp.StatusCode, body: string(respBody)}
	}
	return respBody, nil
}
