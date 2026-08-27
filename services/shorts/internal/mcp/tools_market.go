package mcp

import (
	"context"
	"fmt"
	"regexp"
	"strings"

	"connectrpc.com/connect"
	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

// asxCodeRe mirrors stockCodeRegex in the shorts service's validation.go. The
// handler validates too, but doing it here turns "9ZZZZ" into a clear tool
// error instead of a Connect InvalidArgument the model has to decode.
var asxCodeRe = regexp.MustCompile(`^[A-Z0-9]{3,4}$`)

// GetStockInput is the tool's argument schema. The jsonschema tags are what
// the client (and therefore the model) actually reads, so they describe the
// value, not the field.
type GetStockInput struct {
	Code string `json:"code" jsonschema:"ASX ticker code, 3-4 alphanumeric characters, e.g. BHP, CBA, ZIP. Case-insensitive."`
}

// GetStockOutput is the structured result. It is a projection of the Stock
// message rather than the message itself: an agent needs the units spelled
// out, and a hand-written struct keeps the tool's contract from silently
// widening when a field is added to the proto.
type GetStockOutput struct {
	Code                   string  `json:"code" jsonschema:"ASX ticker code."`
	Name                   string  `json:"name" jsonschema:"Company or product name."`
	Industry               string  `json:"industry,omitempty" jsonschema:"Industry classification, where known."`
	PercentShorted         float64 `json:"percent_shorted" jsonschema:"Reported short positions as a percentage of total product in issue, 0-100."`
	ReportedShortPositions float64 `json:"reported_short_positions" jsonschema:"Number of shares reported as short positions."`
	TotalProductInIssue    float64 `json:"total_product_in_issue" jsonschema:"Total shares on issue."`
}

const getStockDescription = "Look up a single ASX-listed stock by ticker code and return its latest reported " +
	"short position: percent of total product in issue held short (0-100), the raw number of shares " +
	"shorted, total shares on issue, and the company name and industry. " +
	"Source is ASIC's daily short position report, which is published with a T+4 business-day delay — " +
	"the figure returned is the most recent REPORTED position, not today's, and can be up to a week old. " +
	"This is short interest, not short-sale flow, and it is not a price quote: it returns no price, " +
	"volume or market capitalisation."

// getStockTool returns the registry entry for get_stock.
//
// The RPC field is load-bearing — see Tool and TestToolsOnlyCallPublicMethods.
func getStockTool() Tool {
	tool := Tool{
		Name:        "get_stock",
		Title:       "Get ASX stock short position",
		Description: getStockDescription,
		RPC:         "shorts.v1alpha1.StockService.GetStock",
		Domain:      "stock",
	}
	// Closes over tool so the SDK definition is derived from the registry entry
	// rather than restated beside it.
	tool.register = func(server *sdk.Server, src DataSource) {
		sdk.AddTool(server, tool.spec(), getStockHandler(src))
	}
	return tool
}

func getStockHandler(src DataSource) sdk.ToolHandlerFor[GetStockInput, GetStockOutput] {
	return func(ctx context.Context, _ *sdk.CallToolRequest, in GetStockInput) (*sdk.CallToolResult, GetStockOutput, error) {
		code := strings.ToUpper(strings.TrimSpace(in.Code))
		if !asxCodeRe.MatchString(code) {
			// Returned as an error, which the SDK packs into an IsError result
			// rather than a protocol fault, so the model can see it and retry
			// with a corrected argument.
			return nil, GetStockOutput{}, fmt.Errorf(
				"%q is not a valid ASX ticker code: expected 3-4 alphanumeric characters, e.g. BHP", in.Code)
		}

		res, err := src.GetStock(ctx, connect.NewRequest(&shortsv1alpha1.GetStockRequest{
			ProductCode: code,
		}))
		if err != nil {
			// Distinguish "no such stock" from "we broke", because the remedy
			// differs: one is the model's to fix, the other is not.
			if connect.CodeOf(err) == connect.CodeNotFound {
				return nil, GetStockOutput{}, fmt.Errorf(
					"no ASX stock found with code %s — check the ticker, or use search_stocks to find it by company name", code)
			}
			return nil, GetStockOutput{}, fmt.Errorf("could not look up %s: %w", code, err)
		}
		if res == nil || res.Msg == nil {
			return nil, GetStockOutput{}, fmt.Errorf("no data returned for %s", code)
		}

		stock := res.Msg
		out := GetStockOutput{
			Code:                   stock.GetProductCode(),
			Name:                   stock.GetName(),
			Industry:               stock.GetIndustry(),
			PercentShorted:         float64(stock.GetPercentageShorted()),
			ReportedShortPositions: float64(stock.GetReportedShortPositions()),
			TotalProductInIssue:    float64(stock.GetTotalProductInIssue()),
		}

		// A text fallback alongside the structured content: clients that do not
		// consume structuredContent (and humans reading a transcript) otherwise
		// see raw JSON. Setting Content suppresses the SDK's JSON default.
		summary := fmt.Sprintf("%s (%s): %.2f%% of shares on issue reported short (%.0f of %.0f shares).",
			out.Code, nonEmpty(out.Name, "name unknown"), out.PercentShorted,
			out.ReportedShortPositions, out.TotalProductInIssue)
		if out.Industry != "" {
			summary += " Industry: " + out.Industry + "."
		}
		summary += " Source: ASIC short position report, published T+4."

		return &sdk.CallToolResult{
			Content: []sdk.Content{&sdk.TextContent{Text: summary}},
		}, out, nil
	}
}

func nonEmpty(s, fallback string) string {
	if strings.TrimSpace(s) == "" {
		return fallback
	}
	return s
}
