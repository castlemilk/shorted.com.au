package mcp

import (
	"context"
	"testing"

	"github.com/castlemilk/shorted.com.au/services/pkg/protovisibility"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

// Tools call ShortsServer's handlers directly, which skips the Connect
// interceptor chain — including authentication. A tool wrapping a non-public
// RPC would therefore expose it with no auth at all, on a surface we publish
// to anonymous agents. MintToken lives on the same struct.
//
// Every registered tool declares the RPC it calls; this asserts every one of
// those is annotated VISIBILITY_PUBLIC in the protos, using the same registry
// lookup the auth middleware itself uses.
func TestToolsOnlyCallPublicMethods(t *testing.T) {
	public := protovisibility.PublicMethodNames()
	if len(public) == 0 {
		t.Fatal("no public methods found — the proto registry is empty")
	}

	tools := Registry()
	if len(tools) == 0 {
		t.Fatal("no tools registered")
	}

	for _, tool := range tools {
		if tool.RPC == "" {
			t.Errorf("tool %q declares no RPC — it cannot be checked, and an unchecked tool is the bug this test exists to prevent", tool.Name)
			continue
		}
		if !public[tool.RPC] {
			t.Errorf("tool %q calls %s, which is NOT VISIBILITY_PUBLIC — calling it from a tool bypasses auth entirely", tool.Name, tool.RPC)
		}
	}
}

func TestRegistryNamesAreUniqueAndWellFormed(t *testing.T) {
	seen := map[string]bool{}
	for _, tool := range Registry() {
		if seen[tool.Name] {
			t.Errorf("duplicate tool name %q — clients key on name", tool.Name)
		}
		seen[tool.Name] = true

		if tool.Description == "" {
			t.Errorf("tool %q has no description — the model selects tools by description", tool.Name)
		}
	}
}

// A tool that is listed but never wired up is advertised and then fails at
// call time; a tool that is wired up outside Registry() escapes the visibility
// guard entirely. Both are caught by insisting the registry entry carries its
// own registration func.
func TestEveryToolRegistersItself(t *testing.T) {
	for _, tool := range Registry() {
		if tool.register == nil {
			t.Errorf("tool %q has no register func — it would be advertised but uncallable", tool.Name)
		}
		if tool.Domain == "" {
			t.Errorf("tool %q has no domain — the published catalog groups by it", tool.Name)
		}
	}
}

// What the registry says and what tools/list serves must be the same thing.
// The registry is also the source for the published server card, so a tool
// advertised with one description and served with another misleads clients on
// whichever surface they read first — and, worse, a tool registered outside
// Registry() would never face the visibility guard above.
func TestToolsListMatchesTheRegistry(t *testing.T) {
	ctx := context.Background()

	server := NewServer(&fakeDataSource{})
	client := sdk.NewClient(&sdk.Implementation{Name: "registry-test", Version: "0.0.1"}, nil)

	clientTransport, serverTransport := sdk.NewInMemoryTransports()
	serverSession, err := server.Connect(ctx, serverTransport, nil)
	if err != nil {
		t.Fatalf("server connect: %v", err)
	}
	t.Cleanup(func() { _ = serverSession.Close() })

	session, err := client.Connect(ctx, clientTransport, nil)
	if err != nil {
		t.Fatalf("client connect: %v", err)
	}
	t.Cleanup(func() { _ = session.Close() })

	res, err := session.ListTools(ctx, nil)
	if err != nil {
		t.Fatalf("tools/list: %v", err)
	}

	served := map[string]*sdk.Tool{}
	for _, tool := range res.Tools {
		served[tool.Name] = tool
	}

	registered := Registry()
	if len(served) != len(registered) {
		t.Errorf("tools/list served %d tools, Registry() holds %d", len(served), len(registered))
	}

	for _, want := range registered {
		got, ok := served[want.Name]
		if !ok {
			t.Errorf("tool %q is in the registry but not served", want.Name)
			continue
		}
		if got.Description != want.Description {
			t.Errorf("tool %q: served description differs from the registry's", want.Name)
		}
		if got.Title != want.Title {
			t.Errorf("tool %q: served title %q, registry says %q", want.Name, got.Title, want.Title)
		}
		if got.InputSchema == nil {
			t.Errorf("tool %q: no input schema — the model would have to guess arguments", want.Name)
		}
		if got.OutputSchema == nil {
			t.Errorf("tool %q: no output schema — clients cannot consume the result without parsing prose", want.Name)
		}
	}
}
