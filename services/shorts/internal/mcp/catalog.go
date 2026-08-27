package mcp

import (
	"context"
	"encoding/json"
	"net/http"
	"sync"

	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
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

type CatalogAuthentication struct {
	Required bool   `json:"required"`
	Note     string `json:"note,omitempty"`
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
func CatalogHandler(src DataSource) http.Handler {
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
			encoded, err := json.MarshalIndent(BuildCatalog(context.Background(), src), "", "  ")
			if err != nil {
				// Cannot happen for this struct, but returning nothing would
				// be worse than returning the schema-less form.
				encoded, _ = json.MarshalIndent(BuildCatalog(context.Background(), nil), "", "  ")
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

// BuildCatalog renders the registry as the published catalog. Exported so the
// docs generator and tests can render the same document the endpoint serves.
func BuildCatalog(ctx context.Context, src DataSource) Catalog {
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
		Authentication: CatalogAuthentication{
			Required: false,
			Note: "Anonymous access. No token is required and no per-caller quota is applied; " +
				"a per-IP abuse ceiling at the edge is the only limit.",
		},
		ToolCount: len(tools),
		Tools:     tools,
		Resources: resources,
		Prompts:   prompts,
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
