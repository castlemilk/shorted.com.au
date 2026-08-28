package mcp

import (
	"reflect"
	"strings"
	"testing"

	"github.com/castlemilk/shorted.com.au/services/pkg/protovisibility"
)

// TestDataSourceExposesOnlyPublicMethods closes the gap TestToolsOnlyCall-
// PublicMethods cannot see.
//
// That test checks each tool's DECLARED RPC string. It is therefore only as
// honest as the declaration: a tool could declare a public RPC and its handler
// call a different DataSource method entirely, and every assertion would still
// pass. The declaration is a claim; this is the check on what is reachable.
//
// DataSource is the whole of what a tool can reach — *ShortsServer implements
// every rpc on all twelve domain services, MintToken (which issues API
// credentials) among them, and tools invoke these handlers IN-PROCESS, skipping
// the Connect interceptor chain that would otherwise authenticate the caller.
// So the interface's method set is the real security boundary, and widening it
// by one line is all it would take to put a credential-issuing endpoint one
// closure away from an anonymous agent. The compile-time assertion in the
// shorts package would not object: ShortsServer has those methods.
//
// Hence: every method on DataSource must correspond to a VISIBILITY_PUBLIC RPC.
func TestDataSourceExposesOnlyPublicMethods(t *testing.T) {
	public := protovisibility.PublicMethodNames()
	if len(public) == 0 {
		t.Fatal("no public methods found — the proto registry is empty")
	}

	// Index the public set by bare method name. Several services can share a
	// method name, so this maps to every fully-qualified match.
	byName := map[string][]string{}
	for full := range public {
		if i := strings.LastIndex(full, "."); i >= 0 {
			name := full[i+1:]
			byName[name] = append(byName[name], full)
		}
	}

	iface := reflect.TypeOf((*DataSource)(nil)).Elem()
	if iface.NumMethod() == 0 {
		t.Fatal("DataSource has no methods — this test would pass vacuously")
	}

	for i := 0; i < iface.NumMethod(); i++ {
		name := iface.Method(i).Name
		if len(byName[name]) == 0 {
			t.Errorf(
				"DataSource declares %s, which matches no VISIBILITY_PUBLIC rpc — "+
					"a tool reaching it would bypass authentication entirely",
				name,
			)
		}
	}
}

// TestDataSourceMethodsAreAllReachableFromSomeTool is the converse: an unused
// method on DataSource is dead weight that widens the reachable surface for
// nothing. Kept separate from the security assertion above because failing it
// is untidiness, not a hole.
func TestDataSourceMethodsAreAllReachableFromSomeTool(t *testing.T) {
	declared := map[string]bool{}
	for _, tool := range Registry() {
		if i := strings.LastIndex(tool.RPC, "."); i >= 0 {
			declared[tool.RPC[i+1:]] = true
		}
	}

	iface := reflect.TypeOf((*DataSource)(nil)).Elem()
	for i := 0; i < iface.NumMethod(); i++ {
		name := iface.Method(i).Name
		if !declared[name] {
			t.Errorf(
				"DataSource declares %s but no tool declares it — remove it rather "+
					"than leaving a method the tools can reach and nothing checks",
				name,
			)
		}
	}
}
