package mcp

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"

	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

// Tool descriptions and error messages routinely tell the model to call a
// different tool instead — "use screen_stocks when the question has criteria",
// "call list_reports to see which periods exist". That cross-referencing is the
// main defence against a model picking the wrong tool, so it is load-bearing
// prose rather than decoration.
//
// It is also unverified prose. Task 3 shipped descriptions and not-found
// messages naming search_stocks, screen_stocks and get_stock_news a full task
// before those tools existed: a model following the advertised remedy would
// have called a tool that wasn't there and got a protocol error instead of an
// answer. Renaming a tool later would reintroduce exactly that, silently.
//
// Tool names are verb-prefixed (get_/list_/search_/screen_), which is what
// separates them from the snake_case FIELD names that also appear in prose
// (days_to_cover, summary_only, product_codes). Scanning the source rather than
// only Registry() descriptions catches the error strings too, since those live
// in handler code.
var toolNameLike = regexp.MustCompile(`\b(?:get|list|search|screen)_[a-z][a-z_]*\b`)

func TestEveryToolNameMentionedInSourceExists(t *testing.T) {
	registered := map[string]bool{}
	for _, tool := range Registry() {
		registered[tool.Name] = true
	}
	if len(registered) == 0 {
		t.Fatal("no tools registered — this test would pass vacuously")
	}

	files, err := filepath.Glob("tools_*.go")
	if err != nil {
		t.Fatalf("glob: %v", err)
	}
	if len(files) == 0 {
		t.Fatal("no tool source files found — this test would pass vacuously")
	}

	// Field and helper names that share the verb prefix but are not tools.
	// Keep this list short: every entry is a place the heuristic gave up.
	notATool := map[string]bool{
		"get_stock_page": true, // an operationId in the OpenAPI doc, not an MCP tool
	}

	missing := map[string][]string{}
	for _, file := range files {
		if strings.HasSuffix(file, "_test.go") {
			continue
		}
		src, err := os.ReadFile(file)
		if err != nil {
			t.Fatalf("read %s: %v", file, err)
		}
		for _, name := range toolNameLike.FindAllString(string(src), -1) {
			if registered[name] || notATool[name] {
				continue
			}
			missing[name] = append(missing[name], file)
		}
	}

	for name, files := range missing {
		t.Errorf(
			"%s is named in %s but is not a registered tool — a model following that "+
				"advice calls a tool that does not exist",
			name, strings.Join(dedupe(files), ", "),
		)
	}
}

func dedupe(in []string) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, v := range in {
		if !seen[v] {
			seen[v] = true
			out = append(out, v)
		}
	}
	sort.Strings(out)
	return out
}

// The tools/list response is preamble: every client pays it, in full, at the
// start of every session, before the user has asked anything. It was 23.4KB at
// 9 tools, 46KB at 14, and 72KB at the full 24.
//
// The ceiling was raised from 64KB (set when there were 14 tools) after the
// surface was measured at ~3.0KB per tool. Getting 24 tools under 64KB was
// tried and rejected: it required deleting output fields that carry meaning —
// the coverage lists that stop an empty register reading as "this member
// declared nothing", and the per-series source/licence that carries the CC-BY
// credit we are obliged to pass on. Losing those is worse than the bytes.
//
// WHEN THIS FAILS, THE LEVER IS FEWER FIELDS AND FEWER FIELD DESCRIPTIONS.
// It is NOT flattening or type reuse, and this is counter-intuitive enough to
// be worth stating: **the SDK emits no $defs and no $ref** — every nested
// struct is fully INLINED at every use site (verified on the emitted schema:
// no $defs key, no $ref, and a shared 14-field row type appearing once per
// field that uses it). So sharing a type across four fields costs four copies.
// Merging get_report's three ranked-section types into one shared row type was
// measured to make tools/list 2,229 bytes WORSE and was reverted.
//
// Deleting a field description where the field NAME already says it is nearly
// free and was worth ~2.7KB across two tools. Deleting the descriptions that
// differentiate similar tools, or that carry a unit, a caveat or an
// LLM-provenance label, is not on the table — those are what make tool
// selection and honest citation work.
func TestToolsListPreambleStaysWithinBudget(t *testing.T) {
	const budget = 76 * 1024

	ctx := context.Background()
	server := NewServer(&fakeDataSource{})

	clientTransport, serverTransport := sdk.NewInMemoryTransports()
	serverSession, err := server.Connect(ctx, serverTransport, nil)
	if err != nil {
		t.Fatalf("server connect: %v", err)
	}
	defer serverSession.Close()

	client := sdk.NewClient(&sdk.Implementation{Name: "budget-probe", Version: "0.0.1"}, nil)
	session, err := client.Connect(ctx, clientTransport, nil)
	if err != nil {
		t.Fatalf("client connect: %v", err)
	}
	defer session.Close()

	res, err := session.ListTools(ctx, nil)
	if err != nil {
		t.Fatalf("tools/list: %v", err)
	}

	encoded, err := json.Marshal(res)
	if err != nil {
		t.Fatalf("marshal tools/list: %v", err)
	}
	size := len(encoded)
	t.Logf("tools/list is %d bytes across %d tools (%d bytes/tool average)",
		size, len(res.Tools), size/max(1, len(res.Tools)))

	if size > budget {
		t.Errorf(
			"tools/list is %d bytes, over the %d-byte budget — every session pays this "+
				"before the first question. Cut FIELDS or field descriptions whose name "+
				"already says it; do NOT flatten or share output types (the SDK inlines "+
				"every nested struct at every use site, so reuse costs more, not less).",
			size, budget,
		)
	}
}
