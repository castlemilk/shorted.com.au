package mcp

import (
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

// Tool is one registered MCP tool. RPC is the fully-qualified Connect method
// it calls and is NOT decoration: TestToolsOnlyCallPublicMethods uses it to
// prove the tool cannot reach a method that requires auth. A tool with an
// empty RPC fails that test by design.
type Tool struct {
	Name        string
	Title       string
	Description string
	RPC         string
	Domain      string
	register    func(*sdk.Server, DataSource)
}

// spec renders the registry entry as the SDK's tool definition, so what
// tools/list advertises and what the catalog publishes are the same strings by
// construction. Restating the name and description at the AddTool call site is
// how an advertisement drifts from the thing it advertises.
//
// Every tool here is a read-only lookup, hence the blanket annotation.
func (t Tool) spec() *sdk.Tool {
	return &sdk.Tool{
		Name:        t.Name,
		Title:       t.Title,
		Description: t.Description,
		Annotations: &sdk.ToolAnnotations{ReadOnlyHint: true},
	}
}

// Registry returns every tool this server exposes. It is the single source of
// truth for tools/list, for the published server card, and for the safety
// test — so a tool cannot be advertised without being checked.
//
// It returns a fresh slice per call rather than exposing a package-level var:
// callers include a test that iterates it and an HTTP catalog handler, and
// neither should be able to mutate what the server registers.
func Registry() []Tool {
	return []Tool{
		// Market — rankings, sector aggregates, point-in-time snapshots.
		listTopShortsTool(),
		getIndustryTreemapTool(),
		getMarketSnapshotTool(),
		listSqueezeCandidatesTool(),

		// Stock — single-company lookups.
		getStockTool(),
		getStockHistoryTool(),
		getStockDetailsTool(),
		getDirectorTradesTool(),
		getPeerComparisonTool(),
	}
}

// registerAll wires every registered tool onto the SDK server.
//
// It walks Registry() rather than calling registration funcs directly, which
// is what makes the registry authoritative: a tool that skipped this list
// would be callable without ever passing the visibility guard.
func registerAll(server *sdk.Server, src DataSource) {
	for _, tool := range Registry() {
		if tool.register == nil {
			continue
		}
		tool.register(server, src)
	}
}
