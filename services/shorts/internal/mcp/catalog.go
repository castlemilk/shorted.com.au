package mcp

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"

	sdk "github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/castlemilk/shorted.com.au/services/pkg/ratelimit"
)

// The published tool catalog, served at /mcp/catalog.json.
//
// It exists because the server card at /.well-known/mcp/server-card.json used
// to hand-list four tools, three of which no longer existed under those names.
// A hand-written advertisement drifts; the OpenAPI spec hit exactly this in
// Phase 1. Anything that describes this server to the outside world now
// renders from here, and here renders from Registry().
//
// The tool schemas are read out of a real MCP session rather than reconstructed:
// the SDK infers each input schema from the handler's Go types inside AddTool,
// so the only way to publish the schema a client will actually be validated
// against is to ask the server for it. That makes the catalog literally what
// tools/list serves, not a second description of it.

// PublicEndpoint is the URL clients connect to. It is published in the catalog
// and, through it, in the server card — changing it breaks discovery for every
// client that has not yet been reconfigured.
const PublicEndpoint = "https://api.shorted.com.au/mcp"

// DocumentationURL is the human-facing connection guide.
const DocumentationURL = "https://shorted.com.au/docs/mcp.md"

// protocolVersion is the protocol this server prefers. The SDK negotiates
// older versions down from it; server_test.go asserts the negotiated value
// matches, so this constant and reality cannot part company silently.
const protocolVersion = "2026-07-28"

type CatalogServer struct {
	Name            string `json:"name"`
	Title           string `json:"title"`
	Version         string `json:"version"`
	Description     string `json:"description"`
	ProtocolVersion string `json:"protocolVersion"`
	Endpoint        string `json:"endpoint"`
	Transport       string `json:"transport"`
	Documentation   string `json:"documentation"`
	Website         string `json:"website"`
	Contact         string `json:"contact"`
}

// CatalogAuthentication describes how a client authenticates, and — just as
// importantly — that it does not have to.
//
// Required stays FALSE, and that is a statement of fact rather than a
// placeholder: all 24 tools work with no credential at all, which is what makes
// this server adoptable. OAuth RAISES quota and identifies the caller; it is
// not a gate on first contact.
//
// The OAuth fields are advertised anyway, because a client that wants a higher
// ceiling should not have to discover the flow by first being refused. They are
// the same URLs the RFC 9728 challenge and the RFC 8414 document serve, derived
// from one origin so dev, preview and prod each advertise themselves.
type CatalogAuthentication struct {
	Required bool   `json:"required"`
	Note     string `json:"note,omitempty"`
	// Optional names the scheme a client MAY use. Empty when OAuth is not
	// configured for this deployment.
	Optional string `json:"optional,omitempty"`
	// ProtectedResourceMetadata is the RFC 9728 document (the one the
	// WWW-Authenticate challenge points at).
	ProtectedResourceMetadata string `json:"protectedResourceMetadata,omitempty"`
	// AuthorizationServerMetadata is the RFC 8414 document: where the human is
	// sent, where the code is exchanged, and that S256 is the only PKCE method.
	AuthorizationServerMetadata string `json:"authorizationServerMetadata,omitempty"`
	// Scopes is the vocabulary a client may request. Every one is read-only.
	Scopes []string `json:"scopes,omitempty"`
	// RateLimits states what authenticating actually buys, in the same numbers
	// services/pkg/ratelimit enforces. Advertising a ceiling we do not enforce
	// (or enforcing one we do not advertise) is the failure this exists to
	// avoid — #455 found three published tier rows over-promising against the
	// code, and the fix was to make the published numbers derive from it.
	RateLimits *CatalogRateLimits `json:"rateLimits,omitempty"`
}

// CatalogRateLimits is the honest version of "what do I get".
//
// Per-TOOL-CALL, not per request: session preamble (initialize, tools/list,
// resources/list, prompts/list) is free, and a JSON-RPC batch is charged for
// each call it carries.
type CatalogRateLimits struct {
	Unit string `json:"unit"`
	// Enforced says whether THIS deployment applies the per-caller tier quotas
	// below.
	//
	// It is read from the running config, not assumed. A deployment with the
	// app-layer limiter switched off still publishes the numbers — they are the
	// documented entitlement — but must not claim to apply them. Publishing a
	// ceiling nobody enforces is the same defect as enforcing one nobody
	// published, and #455 is the reason this field is a boolean from config
	// rather than a sentence someone remembers to update.
	Enforced    bool   `json:"enforced"`
	Anonymous   string `json:"anonymous"`
	Free        string `json:"free"`
	Paid        string `json:"paid"`
	UpgradeURL  string `json:"upgradeUrl"`
	Description string `json:"description"`
}

type CatalogTool struct {
	Name        string `json:"name"`
	Title       string `json:"title,omitempty"`
	Description string `json:"description"`
	Domain      string `json:"domain"`
	// RPC is the public Connect-RPC method the tool calls, so a caller who
	// wants the uncapped payload can go straight to the HTTP API.
	RPC         string          `json:"rpc,omitempty"`
	ReadOnly    bool            `json:"readOnly"`
	InputSchema json.RawMessage `json:"inputSchema,omitempty"`
}

type CatalogResource struct {
	URI         string `json:"uri"`
	Name        string `json:"name"`
	Title       string `json:"title,omitempty"`
	Description string `json:"description"`
	MIMEType    string `json:"mimeType,omitempty"`
}

type CatalogPromptArgument struct {
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
	Required    bool   `json:"required"`
}

type CatalogPrompt struct {
	Name        string                  `json:"name"`
	Title       string                  `json:"title,omitempty"`
	Description string                  `json:"description"`
	Arguments   []CatalogPromptArgument `json:"arguments,omitempty"`
	Tools       []string                `json:"tools,omitempty"`
}

// Catalog is the published document.
type Catalog struct {
	Server         CatalogServer         `json:"server"`
	Authentication CatalogAuthentication `json:"authentication"`
	ToolCount      int                   `json:"toolCount"`
	Tools          []CatalogTool         `json:"tools"`
	Resources      []CatalogResource     `json:"resources"`
	Prompts        []CatalogPrompt       `json:"prompts"`
}

const catalogDescription = "Read-only Model Context Protocol access to Australian market and " +
	"public-interest data: ASIC short positions for ASX-listed stocks, prices, director trades, " +
	"news and reports; house prices and suburb profiles; ABS/RBA economic series; and the federal " +
	"register of politicians' interests."

// CatalogHandler serves GET /mcp/catalog.json.
//
// src may be nil, which yields a catalog with descriptions but no input
// schemas. That is the fail-soft path, not an error path: a broken catalog
// breaks the server card, and a broken server card breaks discovery for every
// client at once.
func CatalogHandler(src DataSource, opts CatalogOptions) http.Handler {
	// Built once and cached. Spinning up an in-memory MCP session is cheap but
	// not free, and the catalog only changes when the binary does.
	var (
		once sync.Once
		body []byte
	)

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}

		once.Do(func() {
			// NOT r.Context(). The result is cached for the life of the
			// process, so building it under the first caller's request context
			// means one client hanging up mid-build poisons the catalog for
			// everyone afterwards: the in-memory session fails on a cancelled
			// context, the schemas come back empty, and the schema-less form is
			// what every subsequent request gets. The build is local and does
			// no network I/O, so it has no business being cancellable by a
			// request at all.
			encoded, err := json.MarshalIndent(BuildCatalogFor(context.Background(), src, opts), "", "  ")
			if err != nil {
				// Cannot happen for this struct, but returning nothing would
				// be worse than returning the schema-less form.
				encoded, _ = json.MarshalIndent(BuildCatalogFor(context.Background(), nil, opts), "", "  ")
			}
			body = encoded
		})

		w.Header().Set("Content-Type", "application/json")
		// Agents fetch this cross-origin from browser contexts, and it is
		// entirely public.
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Cache-Control", "public, max-age=3600")
		if r.Method == http.MethodHead {
			return
		}
		_, _ = w.Write(body)
	})
}

// BuildCatalog renders the registry as the published catalog for the default
// public origin. Exported so the docs generator and tests can render the same
// document the endpoint serves.
func BuildCatalog(ctx context.Context, src DataSource) Catalog {
	return BuildCatalogForOrigin(ctx, src, DefaultAPIBaseURL)
}

// CatalogOptions carries the deployment facts the catalog must state rather
// than guess.
type CatalogOptions struct {
	// APIBaseURL is this deployment's origin. Discovery URLs derive from it, so
	// a preview advertises its own authorization server rather than
	// production's — otherwise a client authorises against prod and receives a
	// token this deployment refuses by audience.
	APIBaseURL string
	// RateLimitEnabled is whether the app-layer limiter is actually on.
	RateLimitEnabled bool
}

// BuildCatalogForOrigin renders the catalog for an origin, with per-caller
// quotas advertised as UNENFORCED. Kept for callers that have no config to
// hand; anything inside the server should use BuildCatalogFor.
func BuildCatalogForOrigin(ctx context.Context, src DataSource, apiBaseURL string) Catalog {
	return BuildCatalogFor(ctx, src, CatalogOptions{APIBaseURL: apiBaseURL})
}

// BuildCatalogFor renders the catalog from the deployment's own facts.
func BuildCatalogFor(ctx context.Context, src DataSource, opts CatalogOptions) Catalog {
	apiBaseURL := opts.APIBaseURL
	if apiBaseURL == "" {
		apiBaseURL = DefaultAPIBaseURL
	}
	schemas := toolInputSchemas(ctx, src)

	tools := make([]CatalogTool, 0, len(Registry()))
	for _, tool := range Registry() {
		tools = append(tools, CatalogTool{
			Name:        tool.Name,
			Title:       tool.Title,
			Description: tool.Description,
			Domain:      tool.Domain,
			RPC:         tool.RPC,
			ReadOnly:    true,
			InputSchema: schemas[tool.Name],
		})
	}

	resources := make([]CatalogResource, 0, len(Resources()))
	for _, resource := range Resources() {
		resources = append(resources, CatalogResource{
			URI:         resource.URI,
			Name:        resource.Name,
			Title:       resource.Title,
			Description: resource.Description,
			MIMEType:    resource.MIMEType,
		})
	}

	prompts := make([]CatalogPrompt, 0, len(Prompts()))
	for _, prompt := range Prompts() {
		args := make([]CatalogPromptArgument, 0, len(prompt.Arguments))
		for _, arg := range prompt.Arguments {
			args = append(args, CatalogPromptArgument{
				Name:        arg.Name,
				Description: arg.Description,
				Required:    arg.Required,
			})
		}
		prompts = append(prompts, CatalogPrompt{
			Name:        prompt.Name,
			Title:       prompt.Title,
			Description: prompt.Description,
			Arguments:   args,
			Tools:       prompt.Tools,
		})
	}

	return Catalog{
		Server: CatalogServer{
			Name:            ServerName,
			Title:           ServerTitle,
			Version:         ServerVersion,
			Description:     catalogDescription,
			ProtocolVersion: protocolVersion,
			Endpoint:        PublicEndpoint,
			Transport:       "streamable-http",
			Documentation:   DocumentationURL,
			Website:         "https://shorted.com.au",
			Contact:         "support@shorted.com.au",
		},
		Authentication: buildCatalogAuthentication(apiBaseURL, opts.RateLimitEnabled),
		ToolCount:      len(tools),
		Tools:          tools,
		Resources:      resources,
		Prompts:        prompts,
	}
}

// toolInputSchemas asks a live server for the schemas it will validate against.
//
// Reconstructing them here would be a second implementation of the SDK's type
// inference, and the two would diverge on the first tool whose argument struct
// changed. Any failure returns an empty map: the catalog then publishes names
// and descriptions without schemas, which is degraded but still discoverable.
func toolInputSchemas(ctx context.Context, src DataSource) map[string]json.RawMessage {
	schemas := map[string]json.RawMessage{}
	if src == nil {
		return schemas
	}

	server := NewServer(src)
	client := sdk.NewClient(&sdk.Implementation{Name: "catalog", Version: ServerVersion}, nil)

	clientTransport, serverTransport := sdk.NewInMemoryTransports()
	serverSession, err := server.Connect(ctx, serverTransport, nil)
	if err != nil {
		return schemas
	}
	defer func() { _ = serverSession.Close() }()

	session, err := client.Connect(ctx, clientTransport, nil)
	if err != nil {
		return schemas
	}
	defer func() { _ = session.Close() }()

	res, err := session.ListTools(ctx, nil)
	if err != nil {
		return schemas
	}
	for _, tool := range res.Tools {
		if tool == nil || tool.InputSchema == nil {
			continue
		}
		encoded, err := json.Marshal(tool.InputSchema)
		if err != nil {
			continue
		}
		schemas[tool.Name] = encoded
	}
	return schemas
}

// buildCatalogAuthentication states what a client gets with and without a
// token, in numbers taken from the limiter rather than written down here.
//
// THE FAILURE THIS AVOIDS. #455 found three published tier rows over-promising
// against what the code enforced (anonymous 1,000 against an enforced 500, free
// 2,000 against 1,000, paid per-minute "unlimited" against a real 120). A
// published ceiling is a promise, and the only way to keep one is to derive it
// from the thing that enforces it.
//
// The numbers come from ratelimit.DefaultConfig, which is what runs unless a
// deployment overrides a tier by environment — none does today, and the note
// says "current defaults" rather than claiming more than that.
func buildCatalogAuthentication(apiBaseURL string, rateLimitEnforced bool) CatalogAuthentication {
	cfg := ratelimit.DefaultConfig()
	perCall := func(tier string) string {
		limits, ok := cfg.Tiers[tier]
		if !ok {
			return "unspecified"
		}
		// The API column, not the browser column: MCP is a programmatic
		// surface, and paid BROWSER access being unlimited is exactly the
		// over-promise that made `access` load-bearing in RateLimitDetail.
		if limits.RequestsPerMinute == 0 && limits.RequestsPerMonth == 0 {
			return "unlimited"
		}
		return fmt.Sprintf("%d per minute, %d per month",
			limits.RequestsPerMinute, limits.RequestsPerMonth)
	}

	note := "Anonymous access. No token is required and every tool works without one — " +
		"OAuth 2.1 identifies you and raises the per-caller quota, it is not a gate on " +
		"first contact. Quota is counted per TOOL CALL: the session handshake, tools/list, " +
		"resources/list and prompts/list are free."
	description := "Enforced by the API after authentication (services/pkg/ratelimit). " +
		"A separate, tier-blind per-IP ceiling at the Cloudflare edge protects the origin " +
		"and sits above these numbers."
	if !rateLimitEnforced {
		// Say so plainly. A client that plans around a quota we do not apply is
		// only mildly inconvenienced; a client TOLD a quota applies when it does
		// not has been given a false number by us, which is worse than saying
		// nothing.
		note = "Anonymous access. No token is required and every tool works without one — " +
			"OAuth 2.1 identifies you, it is not a gate on first contact. This deployment " +
			"does not currently apply per-caller quotas; the only limit in force is a " +
			"tier-blind per-IP ceiling at the Cloudflare edge."
		description = "NOT currently enforced by this deployment. These are the documented " +
			"API tier entitlements, which apply once app-layer rate limiting is enabled. " +
			"The ceiling actually in force is the tier-blind per-IP limit at the Cloudflare " +
			"edge (60 per 10 seconds and 300 per minute for anonymous MCP callers, counted " +
			"per HTTP request rather than per tool call)."
	}

	return CatalogAuthentication{
		Required:                    false,
		Note:                        note,
		Optional:                    "oauth2",
		ProtectedResourceMetadata:   ProtectedResourceMetadataURL(apiBaseURL),
		AuthorizationServerMetadata: strings.TrimSuffix(apiBaseURL, "/") + "/.well-known/oauth-authorization-server",
		Scopes:                      Scopes,
		RateLimits: &CatalogRateLimits{
			Unit:        "tool call",
			Enforced:    rateLimitEnforced,
			Anonymous:   perCall("anonymous"),
			Free:        perCall("free"),
			Paid:        perCall("premium"),
			UpgradeURL:  cfg.UpgradeURL,
			Description: description,
		},
	}
}
