package mcp

import (
	"context"
	_ "embed"
	"fmt"

	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

// MCP resources: the context an agent needs to INTERPRET tool output, which
// the tools themselves cannot carry.
//
// Each tool description already states its own caveats — its cap, its source,
// when to prefer a different tool. What none of them can state, because it
// would have to be repeated 24 times and would still only be read by whichever
// tool happened to be called, is the cross-cutting material: what a net short
// position actually is, why every reading is four trading days stale, what is
// deliberately absent from the data set, and what this endpoint costs to use.
// That is exactly what a resource is for.
//
// The prose is embedded rather than fetched. It could in principle be served
// from web/public/llms.txt or the glossary, but this binary is the API service
// and has no access to the web app's filesystem; fetching shorted.com.au at
// read time would put a network hop and the WAF between an agent and its
// interpretation notes. So these files hold the minimum that must live here
// and LINK to the canonical longer-form pages rather than duplicating them —
// the glossary, llms.txt and /docs/api.md stay the source of truth for their
// own material.
//
// Three resources, not eight: resources/list is session preamble in most
// clients, so each one costs every session whether it is read or not.

const (
	readingGuideURI = "shorted://guide/reading-the-data"
	coverageURI     = "shorted://catalog/coverage"
	accessURI       = "shorted://guide/access"
)

//go:embed content/reading-the-data.md
var readingGuideContent string

//go:embed content/coverage.md
var coverageContent string

//go:embed content/access.md
var accessContent string

// Resource is one registered MCP resource. Like Tool, the registry entry is
// the single source of truth: the SDK definition and the served body are both
// derived from it, so an advertised resource cannot describe a body it does
// not serve.
type Resource struct {
	URI         string
	Name        string
	Title       string
	Description string
	MIMEType    string
	Text        string
}

func (r Resource) spec() *sdk.Resource {
	return &sdk.Resource{
		URI:         r.URI,
		Name:        r.Name,
		Title:       r.Title,
		Description: r.Description,
		MIMEType:    r.MIMEType,
		Size:        int64(len(r.Text)),
	}
}

// Resources returns every resource this server exposes. Fresh slice per call,
// for the same reason Registry() returns one: a caller iterating it should not
// be able to mutate what the server serves.
func Resources() []Resource {
	return []Resource{
		{
			URI:   readingGuideURI,
			Name:  "reading-the-data",
			Title: "Reading Shorted's data",
			Description: "How to interpret short-interest figures from this server: net vs gross, " +
				"the T+4 publication delay, the 0.01% reporting threshold, days to cover, and the " +
				"readings that are routinely misread. Read this before drawing a conclusion from a percentage.",
			MIMEType: "text/markdown",
			Text:     readingGuideContent,
		},
		{
			URI:   coverageURI,
			Name:  "coverage",
			Title: "Coverage and exclusions",
			Description: "What each domain (market, housing, economy, politicians) actually contains, " +
				"how fresh it is, and the licence-driven exclusions that will never be filled — " +
				"no individual property listings, no declared-interest amounts, no rewritten parliamentary prose.",
			MIMEType: "text/markdown",
			Text:     coverageContent,
		},
		{
			URI:   accessURI,
			Name:  "access",
			Title: "Access, limits and further reading",
			Description: "This endpoint is anonymous and unmetered, but sits behind a per-IP abuse " +
				"ceiling. Covers back-off behaviour, the HTTP API alternative, and the canonical URL " +
				"shapes for linking a result back to a human-readable page.",
			MIMEType: "text/markdown",
			Text:     accessContent,
		},
	}
}

// registerResources wires every registered resource onto the SDK server.
//
// Deliberately independent of DataSource: these are static documents, and a
// client that cannot reach a tool can still need to know what T+4 means.
func registerResources(server *sdk.Server) {
	for _, resource := range Resources() {
		server.AddResource(resource.spec(), resourceHandler(resource))
	}
}

func resourceHandler(resource Resource) sdk.ResourceHandler {
	return func(_ context.Context, req *sdk.ReadResourceRequest) (*sdk.ReadResourceResult, error) {
		// The SDK routes by URI, so a mismatch here means the SDK and the
		// registry disagree — fail rather than serve the wrong document under
		// the requested URI.
		if req != nil && req.Params != nil && req.Params.URI != resource.URI {
			return nil, fmt.Errorf("resource %q is not served here", req.Params.URI)
		}
		return &sdk.ReadResourceResult{
			Contents: []*sdk.ResourceContents{{
				URI:      resource.URI,
				MIMEType: resource.MIMEType,
				Text:     resource.Text,
			}},
		}, nil
	}
}
