package mcp

import (
	"context"
	"encoding/json"

	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

// structuredContentAsText appends a tool's structured result to its text
// content, as the serialized JSON.
//
// Every tool here answers with a short summary in content and the data in
// structuredContent, and clients do not read both. Claude Code hands its model
// structuredContent; claude.ai hands its model content. So on claude.ai the
// model saw the summary and nothing else: get_stock_prices arrived as "first
// close, last close, N sessions" with every daily row dropped, the briefing's
// dividends arrived as "4 dividend records", and the model went to the HTTP
// API for the rows instead (2026-10-17).
//
// The spec says a tool returning structured content SHOULD also return the
// serialized JSON in a TextContent block (2025-06-18, "Structured content").
// The SDK does that by itself when a handler leaves Content nil; setting the
// summary is what switched it off. The summary stays first, because it is
// what a person reads in a transcript.
//
// It is server middleware rather than a line in each handler so that a new
// tool cannot leave it out.
func structuredContentAsText(next sdk.MethodHandler) sdk.MethodHandler {
	return func(ctx context.Context, method string, req sdk.Request) (sdk.Result, error) {
		result, err := next(ctx, method, req)
		if err != nil || method != "tools/call" {
			return result, err
		}
		res, ok := result.(*sdk.CallToolResult)
		if !ok || res == nil || res.IsError || res.StructuredContent == nil {
			return result, err
		}

		// The SDK hands over the RawMessage it validated against the output
		// schema, so this is the exact structuredContent on the wire.
		raw, ok := res.StructuredContent.(json.RawMessage)
		if !ok {
			b, mErr := json.Marshal(res.StructuredContent)
			if mErr != nil {
				return result, err
			}
			raw = b
		}
		text := string(raw)

		// The SDK already appends the JSON when the result is not an object;
		// a second copy would only cost the reader's context.
		for _, c := range res.Content {
			if t, ok := c.(*sdk.TextContent); ok && t.Text == text {
				return result, err
			}
		}
		res.Content = append(res.Content, &sdk.TextContent{Text: text})
		return result, err
	}
}
