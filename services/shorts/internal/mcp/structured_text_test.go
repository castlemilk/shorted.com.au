package mcp

import (
	"context"
	"encoding/json"
	"net/http"
	"reflect"
	"strings"
	"testing"

	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

// A client that reads only content (claude.ai) must still receive the data.
// Before structuredContentAsText it received the summary and nothing else:
// get_stock_prices reached the model as its first and last close.
func TestEveryToolResultCarriesItsDataAsText(t *testing.T) {
	ctx := context.Background()
	sess := connectToolSession(t, realisticSource())

	for _, c := range toolCallFixtures() {
		t.Run(c.name, func(t *testing.T) {
			res, err := sess.CallTool(ctx, &sdk.CallToolParams{Name: c.name, Arguments: c.args})
			if err != nil {
				t.Fatal(err)
			}
			if res.IsError {
				t.Fatalf("tool error: %v", res.Content)
			}
			raw, err := json.Marshal(res.StructuredContent)
			if err != nil {
				t.Fatal(err)
			}
			var want any
			if err := json.Unmarshal(raw, &want); err != nil {
				t.Fatal(err)
			}

			copies := 0
			for _, block := range res.Content {
				text, ok := block.(*sdk.TextContent)
				if !ok {
					continue
				}
				var got any
				if json.Unmarshal([]byte(text.Text), &got) == nil && reflect.DeepEqual(got, want) {
					copies++
				}
			}
			if copies != 1 {
				t.Fatalf("content carries the structured result %d times, want exactly once", copies)
			}
		})
	}
}

// The summary stays the first block: it is what a person reads in a transcript,
// and the tool tests read it there.
func TestTheSummaryStaysFirst(t *testing.T) {
	sess := connectToolSession(t, realisticSource())
	res, err := sess.CallTool(context.Background(), &sdk.CallToolParams{
		Name: "get_stock_prices", Arguments: map[string]any{"code": "PLS", "period": "MAX"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Content) != 2 {
		t.Fatalf("content has %d blocks, want the summary and the data", len(res.Content))
	}
	summary := textOf(t, res)
	if !strings.HasPrefix(summary, "PLS: ") {
		t.Errorf("content[0] = %q, want the summary", summary)
	}
	data := res.Content[1].(*sdk.TextContent).Text
	if !strings.Contains(data, `"open":`) || !strings.Contains(data, `"adjusted_close":`) {
		t.Errorf("content[1] does not carry the sessions: %.200s", data)
	}
}

// A tool error has no data, and its message must stay the only block.
func TestAToolErrorGainsNoDataBlock(t *testing.T) {
	sess := connectToolSession(t, realisticSource())
	res, err := sess.CallTool(context.Background(), &sdk.CallToolParams{
		Name: "get_stock_prices", Arguments: map[string]any{"code": "not a ticker"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !res.IsError || len(res.Content) != 1 {
		t.Fatalf("isError = %v with %d blocks, want one error block", res.IsError, len(res.Content))
	}
}

func TestStructuredContentAsTextLeavesOtherMethodsAlone(t *testing.T) {
	listed := &sdk.ListToolsResult{}
	next := func(context.Context, string, sdk.Request) (sdk.Result, error) { return listed, nil }
	got, err := structuredContentAsText(next)(context.Background(), "tools/list", nil)
	if err != nil || got != listed {
		t.Fatalf("got %v, %v; want the result untouched", got, err)
	}
}

// The admin server is a claude.ai connector too.
func TestAdminToolResultsCarryTheirDataAsText(t *testing.T) {
	srv := adminStack(t, stubClaims{claims: adminClaims()}, onlyAdmin("uid-admin"), &fakePublisher{})
	resp, body := adminCall(t, srv, "t", runPicksCall)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d: %s", resp.StatusCode, body)
	}

	// The stateless transport may answer as an SSE event; the message is the
	// data line either way.
	payload := body
	for line := range strings.SplitSeq(body, "\n") {
		if after, ok := strings.CutPrefix(line, "data: "); ok {
			payload = after
		}
	}
	var msg struct {
		Result struct {
			Content []struct {
				Text string `json:"text"`
			} `json:"content"`
			StructuredContent json.RawMessage `json:"structuredContent"`
		} `json:"result"`
	}
	if err := json.Unmarshal([]byte(payload), &msg); err != nil {
		t.Fatalf("decode %s: %v", payload, err)
	}
	blocks := msg.Result.Content
	if len(blocks) != 2 {
		t.Fatalf("content has %d blocks, want the summary and the data: %s", len(blocks), payload)
	}
	var got, want any
	if err := json.Unmarshal([]byte(blocks[1].Text), &got); err != nil {
		t.Fatalf("content[1] is not JSON: %v", err)
	}
	if err := json.Unmarshal(msg.Result.StructuredContent, &want); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("content[1] = %s, want structuredContent %s", blocks[1].Text, msg.Result.StructuredContent)
	}
}
