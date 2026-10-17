package mcp

// Go has no OpenAI MCP extensions SDK. These metadata fields implement the
// published wire contract: https://github.com/openai/mcp-extensions/blob/main/docs/spec.md
import (
	"context"
	_ "embed"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/url"
	"slices"
	"strings"

	"github.com/castlemilk/shorted.com.au/services/shorts/internal/jobmonitor"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

const publicAppURI = "ui://shorted/market-v1.html"
const adminAppURI = "ui://shorted/admin-jobs-v1.html"
const appMIMEType = "text/html;profile=mcp-app"

//go:embed ui/overview.html
var overviewHTML string

func entrypointMeta(uri string) sdk.Meta {
	return sdk.Meta{
		"ui":        map[string]any{"resourceUri": uri, "visibility": []string{"app", "model"}},
		"openai/ui": map[string]any{"entrypoints": []map[string]string{{"type": "global"}, {"type": "thread"}}},
	}
}
func mentionMeta() sdk.Meta {
	return sdk.Meta{"openai/extensions": map[string]any{"mentions/search": map[string]any{}}, "ui": map[string]any{"visibility": []string{"app"}}}
}
func appResourceMeta() sdk.Meta {
	return sdk.Meta{
		"ui":        map[string]any{"prefersBorder": false, "csp": map[string]any{"connectDomains": []string{}, "resourceDomains": []string{}, "frameDomains": []string{}}},
		"openai/ui": map[string]any{"preferredDisplayMode": "inline", "availableDisplayModes": []string{"inline", "fullscreen"}},
	}
}
func entrypointIcons() []sdk.Icon {
	svg := `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="none"><path d="M3 3v14h14M6 11l4-4 3 3 4-6" stroke="currentColor" stroke-width="1.33" stroke-linecap="round" stroke-linejoin="round"/></svg>`
	return []sdk.Icon{{Source: "data:image/svg+xml;base64," + base64.StdEncoding.EncodeToString([]byte(svg)), MIMEType: "image/svg+xml"}}
}
func appResource(admin bool) Resource {
	uri, name, title, mode := publicAppURI, "market-overview", "Market overview", "market"
	if admin {
		uri, name, title, mode = adminAppURI, "async-jobs", "Async jobs", "admin"
	}
	return Resource{URI: uri, Name: name, Title: title, Description: title + " interactive MCP app.", MIMEType: appMIMEType, Text: strings.ReplaceAll(overviewHTML, "__SHORTED_MODE__", mode), Meta: appResourceMeta()}
}

type MentionInput struct {
	Query string `json:"query" jsonschema:"Search text, which may be empty; at most 200 bytes."`
}
type MentionLink struct {
	Type     string `json:"type"`
	URI      string `json:"uri"`
	Name     string `json:"name"`
	Title    string `json:"title,omitempty"`
	MIMEType string `json:"mimeType,omitempty"`
}
type MentionOutput struct {
	Items    []MentionLink `json:"items"`
	Warnings []string      `json:"warnings,omitempty"`
}

func searchStockMentionsTool() Tool {
	t := Tool{Name: "search_stock_mentions", Title: "Mention an ASX stock", Description: "Search ASX stocks for composer mentions. Empty query returns no suggestions; type a company name or ticker. Returns at most 20 resource links.", RPC: "shorts.v1alpha1.SearchService.SearchStocks", Domain: "discovery"}
	t.register = func(server *sdk.Server, src DataSource) {
		spec := t.spec()
		spec.Meta = mentionMeta()
		sdk.AddTool(server, spec, func(ctx context.Context, req *sdk.CallToolRequest, in MentionInput) (*sdk.CallToolResult, MentionOutput, error) {
			out := MentionOutput{Items: []MentionLink{}}
			if len(in.Query) > 200 {
				return nil, out, fmt.Errorf("query must be at most 200 bytes")
			}
			if strings.TrimSpace(in.Query) == "" {
				return nil, out, nil
			}
			_, stocks, err := searchStocksHandler(src)(ctx, req, SearchStocksInput{Query: in.Query, Limit: 20})
			if err != nil {
				return nil, out, err
			}
			for _, s := range stocks.Matches {
				code, err := normaliseCode(s.Code)
				if err != nil {
					continue
				}
				out.Items = append(out.Items, MentionLink{Type: "resource_link", URI: "shorted://stocks/" + code, Name: code, Title: code + " · " + s.Name, MIMEType: "application/json"})
				if len(out.Items) == 20 {
					break
				}
			}
			return nil, out, nil
		})
	}
	return t
}
func registerStockResources(server *sdk.Server, src DataSource) {
	server.AddResourceTemplate(&sdk.ResourceTemplate{URITemplate: "shorted://stocks/{code}", Name: "ASX stock", MIMEType: "application/json"}, func(ctx context.Context, req *sdk.ReadResourceRequest) (*sdk.ReadResourceResult, error) {
		code := strings.TrimPrefix(req.Params.URI, "shorted://stocks/")
		normalized, err := normaliseCode(code)
		if err != nil || code != normalized {
			return nil, fmt.Errorf("invalid stock resource URI")
		}
		_, out, err := getStockHandler(src)(ctx, nil, GetStockInput{Code: code})
		if err != nil {
			return nil, err
		}
		return jsonResource(req.Params.URI, out)
	})
}
func jsonResource(uri string, value any) (*sdk.ReadResourceResult, error) {
	raw, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	cacheScope := "public"
	if strings.HasPrefix(uri, "shorted-admin:") {
		cacheScope = "private"
	}
	return &sdk.ReadResourceResult{Cacheable: sdk.Cacheable{CacheScope: cacheScope}, Contents: []*sdk.ResourceContents{{URI: uri, MIMEType: "application/json", Text: string(raw)}}}, nil
}
func jobResourceURI(j jobmonitor.JobStatus) string {
	region := j.Region
	if region == "" {
		region = "local"
	}
	return "shorted-admin://jobs/" + url.PathEscape(region) + "/" + url.PathEscape(j.Name)
}
func registerAdminResources(server *sdk.Server, reader AdminReader) {
	r := appResource(true)
	server.AddResource(r.spec(), resourceHandler(r))
	if reader == nil {
		return
	}
	server.AddResourceTemplate(&sdk.ResourceTemplate{URITemplate: "shorted-admin://jobs/{region}/{name}", Name: "Async job status", MIMEType: "application/json"}, func(ctx context.Context, req *sdk.ReadResourceRequest) (*sdk.ReadResourceResult, error) {
		// HTTP authentication also protects resources/read, but its per-resource
		// scope must be checked here just like the tools' scope.
		if req.Extra == nil || req.Extra.TokenInfo == nil || !slices.Contains(req.Extra.TokenInfo.Scopes, ScopeJobsRead) {
			return nil, fmt.Errorf("jobs:read scope required; reconnect the admin connector")
		}
		snapshot, err := reader.AsyncJobs(ctx)
		if err != nil {
			return nil, err
		}
		for _, j := range snapshot.Jobs {
			if req.Params.URI == jobResourceURI(j) {
				return jsonResource(req.Params.URI, struct {
					Job        jobmonitor.JobStatus `json:"job"`
					ObservedAt string               `json:"observedAt"`
					Incomplete bool                 `json:"incomplete"`
					Warnings   []string             `json:"warnings"`
				}{j, snapshot.ObservedAt, snapshot.Incomplete, snapshot.Warnings})
			}
		}
		return nil, fmt.Errorf("job resource not found in the observable fleet")
	})
}
