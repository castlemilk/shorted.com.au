package mcp

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

func TestPublicExtensionWireContract(t *testing.T) {
	ctx := context.Background()
	session := connectToolSession(t, realisticSource())
	tools, err := session.ListTools(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, tool := range tools.Tools {
		if tool.Name == "list_top_shorts" {
			raw, _ := json.Marshal(tool.Meta)
			if !strings.Contains(string(raw), publicAppURI) || !strings.Contains(string(raw), `"type":"global"`) || !strings.Contains(string(raw), `"type":"thread"`) || len(tool.Icons) == 0 {
				t.Fatalf("entrypoint: %+v", tool)
			}
			res, err := session.CallTool(ctx, &sdk.CallToolParams{Name: tool.Name, Arguments: map[string]any{}})
			if err != nil || res.IsError {
				t.Fatalf("entrypoint rejects {}: %v %+v", err, res)
			}
		}
		if tool.Name == "search_stock_mentions" {
			raw, _ := json.Marshal(tool.Meta)
			if !strings.Contains(string(raw), `"mentions/search":{}`) || !strings.Contains(string(raw), `"visibility":["app"]`) {
				t.Fatalf("mentions metadata: %s", raw)
			}
		}
	}
	res, err := session.CallTool(ctx, &sdk.CallToolParams{Name: "search_stock_mentions", Arguments: map[string]any{"query": "minerals"}})
	if err != nil || res.IsError {
		t.Fatalf("mentions %v %+v", err, res)
	}
	raw, _ := json.Marshal(res.StructuredContent)
	var out MentionOutput
	_ = json.Unmarshal(raw, &out)
	if len(out.Items) == 0 || len(out.Items) > 20 {
		t.Fatalf("mentions count %d", len(out.Items))
	}
	for _, item := range out.Items {
		if item.Type != "resource_link" || !strings.HasPrefix(item.URI, "shorted://stocks/") {
			t.Fatalf("invalid link %+v", item)
		}
	}
	if _, err := session.ReadResource(ctx, &sdk.ReadResourceParams{URI: out.Items[0].URI}); err != nil {
		t.Fatalf("mention URI did not resolve: %v", err)
	}
	resource, err := session.ReadResource(ctx, &sdk.ReadResourceParams{URI: publicAppURI})
	if err != nil {
		t.Fatal(err)
	}
	if resource.Contents[0].MIMEType != appMIMEType || resource.Contents[0].Meta["ui"] == nil || strings.Contains(resource.Contents[0].Text, "__SHORTED_MODE__") {
		t.Fatal("incomplete app resource")
	}
	if _, err := session.ReadResource(ctx, &sdk.ReadResourceParams{URI: adminAppURI}); err == nil {
		t.Fatal("admin app served on public endpoint")
	}
	if _, err := session.ReadResource(ctx, &sdk.ReadResourceParams{URI: "shorted-admin://jobs/us-central1/shorted-picks"}); err == nil {
		t.Fatal("admin job served on public endpoint")
	}
	if _, err := session.ReadResource(ctx, &sdk.ReadResourceParams{URI: "shorted://stocks/BHP/other"}); err == nil {
		t.Fatal("invalid stock URI accepted")
	}
}
func TestEmptyMentionQueryIsValid(t *testing.T) {
	res, err := connectWithSource(t).CallTool(context.Background(), &sdk.CallToolParams{Name: "search_stock_mentions", Arguments: map[string]any{"query": ""}})
	if err != nil || res.IsError {
		t.Fatalf("empty query %v %+v", err, res)
	}
}
