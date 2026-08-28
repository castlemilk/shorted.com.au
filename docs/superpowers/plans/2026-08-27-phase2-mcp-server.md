# Phase 2: MCP Server (protocol 2026-07-28) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A first-class MCP server covering core Shorted data — shorts/market, housing, economy, politicians — served from the existing Go API at `https://api.shorted.com.au/mcp`, speaking protocol `2026-07-28`.

**Architecture:** A self-contained `services/shorts/internal/mcp` package registers ~24 curated tools against a narrow `DataSource` interface satisfied by `*ShortsServer`, so tools call the existing Connect handlers **in-process** — no HTTP hop, no WAF, no second copy of the business logic. The package is mounted on the existing mux in `serve.go` via the SDK's `StreamableHTTPHandler`. A tool registry is the single source of truth for both `tools/list` and the published server card.

**Tech Stack:** `github.com/modelcontextprotocol/go-sdk` **v1.7.0** (verified: `latestProtocolVersion = "2026-07-28"`, negotiating back through `2025-11-25`/`2025-06-18`/`2025-03-26`/`2024-11-05`), Go 1.26, Connect-RPC.

**Spec:** `docs/superpowers/specs/2026-08-27-mcp-server-and-api-discoverability-design.md` (Part B, Phases 2)

**Depends on:** Phase 1 (PR #509). Reuses `PublicMethodPaths()` from `services/cmd/openapi-postprocess/visibility.go` — see Task 2, which moves it to a shared package.

---

## Context an engineer needs before starting

**The safety property that shapes this whole phase.** `ShortsServer` methods are Connect handlers. Mounted normally, every call passes through the interceptor chain in `serve.go:150-167` — auth (`middleware_connect.go`), user-agent, and rate limiting. **Calling those methods directly from Go does none of that.** So:

> A tool that wraps a non-`VISIBILITY_PUBLIC` RPC bypasses authentication entirely.

That is not a theoretical concern — `MintToken` issues credentials and lives on the same struct. Task 2 therefore builds a test that asserts every RPC reachable from a tool is annotated `VISIBILITY_PUBLIC`, using the same proto-registry lookup the auth middleware itself uses. Adding a tool that wraps a private method must fail the build.

Other things that will otherwise look arbitrary:

- **Protocol `2026-07-28` is handshake-less.** There is a mandatory `server/discover` RPC returning supported versions, capabilities and identity; the version travels in `_meta` (`io.modelcontextprotocol/protocolVersion`) and the `MCP-Protocol-Version` header. The SDK handles negotiation and the legacy `initialize` path — do not hand-roll it.
- **The 12 domain services are already mounted** in `serve.go` via a `mount()` helper that applies `withCORS` + interceptors. Your MCP handler is NOT a Connect handler and must not go through `mount()`.
- **`api.shorted.com.au/*` is routed through the Cloudflare worker** (`services/edge-worker/worker.js`). It hot-caches POST bodies for RPC paths. MCP is JSON-RPC over POST — if the worker caches it, sessions cross-poison. Task 1 verifies `/mcp` is excluded.
- **Phase 2 is anonymous-only.** No OAuth, no per-tool auth, no rate limiting — all Phase 3. Do not build auth scaffolding "ready for" Phase 3; YAGNI.
- **Licence constraints are load-bearing**, not style. Housing crawl rows carry `source_licence='proprietary-tos-restricted'` and are never republished raw. The politician subsystem has **no amount/quantity/value column anywhere** and a migration test asserts none appears — tools must not invent one. APH is CC BY-NC-**ND**: store and emit verbatim atoms, never rewritten prose.
- **`GOWORK=off`** on every Go invocation, to match CI.

---

## The tool surface (24 curated tools)

Not a mechanical wrap of all 68 public methods — tool-count bloat degrades client selection. Each row is `tool_name` → the public RPC it calls.

| Domain | Tools |
|---|---|
| Market (4) | `list_top_shorts`→GetTopShorts · `get_industry_treemap`→GetIndustryTreeMap · `get_market_snapshot`→GetMarketByDate · `list_squeeze_candidates`→GetBattlegroundStocks |
| Stock (5) | `get_stock`→GetStock · `get_stock_history`→GetStockData · `get_stock_details`→GetStockDetails · `get_director_trades`→GetDirectorTrades · `get_peer_comparison`→GetPeerComparison |
| Discovery (2) | `search_stocks`→SearchStocks · `screen_stocks`→ScreenStocks |
| News & reports (3) | `get_stock_news`→GetStockNews · `list_reports`→ListReports · `get_report`→GetWeeklyReport |
| Housing (4) | `get_house_price_series`→GetHousePriceSeries · `get_suburb_profile`→GetSuburbProfile · `list_suburb_price_drops`→ListSuburbPriceDrops · `get_housing_overview`→GetHousingOverview |
| Economy (3) | `list_economic_series`→ListEconomicSeries · `get_economic_series`→GetEconomicSeries · `get_state_company_aggregates`→GetStateCompanyAggregates |
| Politicians (3) | `search_politicians`→ListPoliticians · `get_politician`→GetPolitician · `list_stock_politicians`→ListStockPoliticians |

Every one of these RPCs is confirmed `VISIBILITY_PUBLIC` (they appear in Phase 1's generated spec, which is pruned to exactly that set).

---

## File Structure

| File | Responsibility |
|---|---|
| `services/pkg/protovisibility/visibility.go` (create) | `PublicMethodNames()` — moved from `services/cmd/openapi-postprocess` so both consumers share one implementation |
| `services/shorts/internal/mcp/server.go` (create) | Server assembly, registry → SDK registration, `StreamableHTTPHandler` |
| `services/shorts/internal/mcp/registry.go` (create) | The tool registry type: name, description, RPC it calls, handler |
| `services/shorts/internal/mcp/datasource.go` (create) | The narrow interface `*ShortsServer` satisfies |
| `services/shorts/internal/mcp/tools_market.go` (create) | Market + stock tools |
| `services/shorts/internal/mcp/tools_discovery.go` (create) | search, screener, news, reports |
| `services/shorts/internal/mcp/tools_housing.go` (create) | Housing tools + licence guards |
| `services/shorts/internal/mcp/tools_economy.go` (create) | Economy tools |
| `services/shorts/internal/mcp/tools_politics.go` (create) | Politician tools + licence guards |
| `services/shorts/internal/mcp/resources.go` (create) | MCP resources (glossary, dataset catalog, tier table) |
| `services/shorts/internal/mcp/prompts.go` (create) | MCP prompts |
| `services/shorts/internal/mcp/catalog.go` (create) | Registry → `/mcp/catalog.json` |
| `services/shorts/internal/mcp/*_test.go` | Per-file tests + the visibility guard + protocol conformance |
| `services/shorts/internal/services/shorts/serve.go` (modify) | Mount `/mcp` and `/mcp/catalog.json` |
| `web/src/app/api/agent/mcp-server-card/route.ts` (modify) | Render from the catalog rather than a hand-written list |
| `web/src/app/api/mcp/[transport]/route.ts` (modify) | Deprecation shim pointing at the new endpoint |
| `web/public/docs/mcp.md` + `web/src/app/docs/mcp.md/route.ts` (create) | Connection guide |

---

### Task 1: Mount an empty MCP server and prove the protocol works

Vertical slice first: a server with **zero tools** that a real MCP client can `server/discover` against. This de-risks the SDK, the mount, and the edge before any tool exists.

**Files:**
- Create: `services/shorts/internal/mcp/server.go`
- Create: `services/shorts/internal/mcp/server_test.go`
- Modify: `services/shorts/internal/services/shorts/serve.go`

- [ ] **Step 1: Add the dependency**

```bash
cd services && GOWORK=off go get github.com/modelcontextprotocol/go-sdk@v1.7.0 && GOWORK=off go mod tidy
```

Pin v1.7.0 explicitly. It is the first release whose `latestProtocolVersion` is `2026-07-28` (verified in `mcp/shared.go:51`).

- [ ] **Step 2: Write the failing conformance test**

```go
package mcp

import (
	"context"
	"testing"

	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

// An in-memory client/server pair: the SDK's own transport, so this exercises
// real protocol framing rather than our idea of it.
func TestServerDiscoverReportsIdentityAndVersion(t *testing.T) {
	ctx := context.Background()

	server := NewServer(nil)
	client := sdk.NewClient(&sdk.Implementation{Name: "test-client", Version: "0.0.1"}, nil)

	clientTransport, serverTransport := sdk.NewInMemoryTransports()
	serverSession, err := server.Connect(ctx, serverTransport, nil)
	if err != nil {
		t.Fatalf("server connect: %v", err)
	}
	defer serverSession.Close()

	session, err := client.Connect(ctx, clientTransport, nil)
	if err != nil {
		t.Fatalf("client connect: %v", err)
	}
	defer session.Close()

	got := session.InitializeResult()
	if got.ServerInfo.Name != ServerName {
		t.Errorf("server name = %q, want %q", got.ServerInfo.Name, ServerName)
	}
}
```

**The SDK's exact client-session API may differ from the above** (`InitializeResult`, `NewInMemoryTransports`). Check the real signatures in the module cache before assuming — `go doc github.com/modelcontextprotocol/go-sdk/mcp` — and adjust the test to the real API rather than forcing the SDK to match this sketch. Report what you found.

- [ ] **Step 3: Run it, confirm it fails**

```bash
cd services && GOWORK=off go test ./shorts/internal/mcp/ -run TestServerDiscover -v
```
Expected: FAIL — `undefined: NewServer`.

- [ ] **Step 4: Implement the server**

```go
// Package mcp serves the Shorted data set over the Model Context Protocol.
//
// Tools call ShortsServer's Connect handlers IN-PROCESS. That is the whole
// reason this lives inside the API binary — no HTTP hop, no WAF, no second
// copy of the query logic. It also means the Connect interceptor chain (auth,
// user-agent, rate limiting) does NOT run for these calls, so every RPC a tool
// touches must be VISIBILITY_PUBLIC. TestToolsOnlyCallPublicMethods enforces
// that; do not add a tool without checking it.
package mcp

import (
	"net/http"

	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

const (
	// ServerName is the MCP server identity. It is also published in the
	// server card at /.well-known/mcp/server-card.json — changing it breaks
	// existing client configurations.
	ServerName    = "shorted-au-market-data"
	ServerTitle   = "Shorted — Australian market and public-interest data"
	ServerVersion = "1.0.0"
)

// NewServer builds the MCP server. src may be nil, which yields a server with
// no tools — useful for protocol-level tests.
func NewServer(src DataSource) *sdk.Server {
	server := sdk.NewServer(&sdk.Implementation{
		Name:    ServerName,
		Title:   ServerTitle,
		Version: ServerVersion,
	}, nil)

	if src != nil {
		registerAll(server, src)
	}

	return server
}

// Handler returns the HTTP handler to mount at /mcp.
func Handler(src DataSource) http.Handler {
	server := NewServer(src)
	return sdk.NewStreamableHTTPHandler(func(*http.Request) *sdk.Server {
		return server
	}, nil)
}
```

Create a stub `registerAll` in `registry.go` that does nothing yet, and a stub `DataSource` interface in `datasource.go` (empty for now — Task 2 fills it).

- [ ] **Step 5: Run the test, confirm it passes**

```bash
cd services && GOWORK=off go test ./shorts/internal/mcp/ -v
```

- [ ] **Step 6: Mount it**

In `serve.go`, after the `mount(...)` calls and near the `/health` handler — **not** through `mount()`, which is for Connect handlers and would wrap it in CORS meant for browser RPC:

```go
	// MCP (Model Context Protocol) — protocol 2026-07-28, streamable HTTP.
	// Deliberately NOT via mount(): that helper is for Connect handlers, and
	// this is JSON-RPC. Tools call this same ShortsServer in-process; see the
	// package doc for why that constrains them to public methods.
	mux.Handle("/mcp", mcp.Handler(s))
	mux.Handle("/mcp/", mcp.Handler(s))
```

Both paths: the SDK's streamable transport uses the bare path, and clients sometimes append a trailing segment.

- [ ] **Step 7: Prove it over real HTTP**

Start the API locally (`make dev` or the existing backend target — check `Makefile`), confirm the LISTEN pid is yours (`lsof -nP -iTCP:9091 -sTCP:LISTEN`), then:

```bash
curl -sS -X POST localhost:9091/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'MCP-Protocol-Version: 2026-07-28' \
  -d '{"jsonrpc":"2.0","id":1,"method":"server/discover"}'
```

Expected: a JSON-RPC result naming the server and its supported protocol versions. Paste the real response in your report. Stop the server when done.

- [ ] **Step 8: Check the edge does not cache it**

Read `services/edge-worker/worker.js` and determine whether a POST to `/mcp` on `api.shorted.com.au` would be hot-cached (the worker hashes POST bodies for RPC paths — see `buildHotCacheKey` and the `isRpc` test around line 914). MCP sessions must never be served from cache: two clients would cross-poison.

Report what you find. If `/mcp` **is** cacheable, fix it by excluding the path and add a test alongside `services/edge-worker/ratelimit.test.mjs`. If it is already excluded (e.g. the RPC pattern does not match `/mcp`), say so with the evidence and change nothing.

- [ ] **Step 9: Commit**

```bash
git add services/shorts/internal/mcp/ services/shorts/internal/services/shorts/serve.go services/go.mod services/go.sum
git commit -m "feat(mcp): serve an empty MCP server at /mcp on protocol 2026-07-28"
```

---

### Task 2: The registry, the DataSource, and the safety guard

**Files:**
- Create: `services/pkg/protovisibility/visibility.go`, `visibility_test.go`
- Modify: `services/cmd/openapi-postprocess/visibility.go` (delegate to the shared package)
- Create: `services/shorts/internal/mcp/registry.go`, `datasource.go`, `registry_test.go`

- [ ] **Step 1: Move the visibility lookup to a shared package**

Phase 1 put `PublicMethodPaths()` in `services/cmd/openapi-postprocess/visibility.go`. Two consumers now need it, so it moves to `services/pkg/protovisibility` with **two** exported functions:

```go
// Package protovisibility answers "is this RPC part of the public API?" from
// the proto registry, so the OpenAPI generator and the MCP server cannot
// disagree with the auth middleware about what is public.
package protovisibility

// PublicMethodNames returns the set of fully-qualified method names
// ("shorts.v1alpha1.StockService.GetStock") annotated VISIBILITY_PUBLIC.
func PublicMethodNames() map[string]bool

// PublicMethodPaths returns the same set keyed by OpenAPI path
// ("/shorts.v1alpha1.StockService/GetStock").
func PublicMethodPaths() map[string]bool
```

Keep the existing behaviour exactly: scoped to `shorts.v1alpha1`, legacy `ShortedStocksService` excluded, unannotated methods treated as private. Move the existing tests with it and keep `openapi-postprocess` passing — run `GOWORK=off go test ./cmd/openapi-postprocess/ ./pkg/protovisibility/` and the Phase 1 drift test (`node --test scripts/tests/openapi-drift.test.mjs`) to prove the generated artifact is unchanged.

- [ ] **Step 2: Write the failing safety test**

This is the most important test in the phase.

```go
package mcp

import (
	"testing"

	"github.com/castlemilk/shorted.com.au/services/pkg/protovisibility"
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
```

- [ ] **Step 3: Run it, confirm it fails**

```bash
cd services && GOWORK=off go test ./shorts/internal/mcp/ -run 'TestToolsOnly|TestRegistry' -v
```
Expected: FAIL — `undefined: Registry`.

- [ ] **Step 4: Implement the registry and DataSource**

```go
package mcp

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

// Registry returns every tool this server exposes. It is the single source of
// truth for tools/list, for the published server card, and for the safety
// test — so a tool cannot be advertised without being checked.
func Registry() []Tool { ... }
```

`DataSource` (in `datasource.go`) declares only the methods the tools use, with the real Connect signatures, e.g.:

```go
type DataSource interface {
	GetStock(context.Context, *connect.Request[pb.GetStockRequest]) (*connect.Response[pb.GetStockResponse], error)
	// ... one line per wrapped RPC
}
```

Read the real signatures from `services/shorts/internal/services/shorts/interfaces.go` and the domain handler files — do not guess them. `*ShortsServer` must satisfy this interface with no changes to `ShortsServer` itself; add a compile-time assertion in the shorts package:

```go
var _ mcp.DataSource = (*ShortsServer)(nil)
```

**Do not add all 24 tools yet.** Task 2 ships the registry plus the guard with the tools that Task 3 will populate; if that leaves `Registry()` empty and `TestToolsOnlyCallPublicMethods` failing on "no tools registered", register **one** real tool (`get_stock`) to make the slice honest, and note it.

- [ ] **Step 5: Run, confirm pass. Then prove the guard has teeth.**

Temporarily point `get_stock`'s `RPC` field at `shorts.v1alpha1.BillingService.MintToken` and confirm `TestToolsOnlyCallPublicMethods` fails with the "bypasses auth entirely" message. Restore it exactly. **Paste both outputs in your report** — a safety test that has never been seen to fail is not yet a safety test.

- [ ] **Step 6: Commit**

```bash
git add services/pkg/protovisibility/ services/cmd/openapi-postprocess/ services/shorts/internal/mcp/ services/shorts/internal/services/shorts/
git commit -m "feat(mcp): tool registry with a guard against wrapping non-public RPCs"
```

---

### Tasks 3-7: The tools, by domain

These five tasks share a shape. Each adds its domain's tools to the registry with typed input/output schemas, tests them against a mocked `DataSource`, and commits.

**The contract every tool must meet** (repeated here rather than cross-referenced, because tasks get read out of order):

1. **Typed schemas.** Register with the generic `mcp.AddTool[In, Out](server, &sdk.Tool{...}, handler)` so input and output schemas are derived from Go types. Structured output is what lets a client consume results without parsing prose.
2. **Declare the `RPC` field.** Non-negotiable — it is what the safety test checks.
3. **Descriptions are the model's selection signal.** Say what the tool returns, what the units are, and what the data is NOT. Include the ASIC T+4 delay where relevant. A description like "gets stock data" is a defect.
4. **Cap the payload.** Agents need shape, not 3,000 rows. Time series downsample to ~200 points (the existing Next.js route does this — see `web/src/app/api/mcp/[transport]/route.ts`); list tools take a `limit` with a sane default and a hard maximum. State the cap in the description and report the real byte size of a typical response.
5. **Never invent data.** If the underlying RPC returns nothing, say so — do not synthesise a plausible answer.
6. **Errors are results, not panics.** A failing RPC becomes a tool error with an actionable message.
7. **Test with a mock `DataSource`**, asserting the tool passes through the right request fields and shapes the response as promised. There are existing mocks at `services/shorts/internal/services/shorts/mocks/` — check whether they are reusable before writing new ones.

- [ ] **Task 3 — Market and stock (9 tools).** `list_top_shorts`→GetTopShorts, `get_industry_treemap`→GetIndustryTreeMap, `get_market_snapshot`→GetMarketByDate, `list_squeeze_candidates`→GetBattlegroundStocks, `get_stock`→GetStock, `get_stock_history`→GetStockData, `get_stock_details`→GetStockDetails, `get_director_trades`→GetDirectorTrades, `get_peer_comparison`→GetPeerComparison. Commit: `feat(mcp): market and stock tools`.

- [ ] **Task 4 — Discovery, news and reports (5 tools).** `search_stocks`→SearchStocks, `screen_stocks`→ScreenStocks, `get_stock_news`→GetStockNews, `list_reports`→ListReports, `get_report`→GetWeeklyReport. Note `get_report` takes a slug whose shape disambiguates period (`2026-W23` weekly, `2026-05` monthly, `2025` yearly) — document that in the description. Commit: `feat(mcp): search, screener, news and report tools`.

- [ ] **Task 5 — Housing (4 tools).** `get_house_price_series`→GetHousePriceSeries, `get_suburb_profile`→GetSuburbProfile, `list_suburb_price_drops`→ListSuburbPriceDrops, `get_housing_overview`→GetHousingOverview.

  **Licence guard, and a test for it.** Crawl-derived rows (REA/Domain/property.com.au) carry `source_licence='proprietary-tos-restricted'` and are never republished raw — only derived aggregates are publishable. Before writing these tools, read `docs/feature/housing/data-sources.md` and confirm which fields of each response are publishable. Write a test asserting no housing tool emits a restricted field. If a response message mixes publishable and restricted fields, the tool must project rather than pass through. Honour the `HOUSING_DROP_LISTINGS_ENABLED` / `HOUSING_VALUATIONS_ENABLED` kill switches. Commit: `feat(mcp): housing tools, restricted to the publishable surface`.

- [ ] **Task 6 — Economy (3 tools).** `list_economic_series`→ListEconomicSeries, `get_economic_series`→GetEconomicSeries, `get_state_company_aggregates`→GetStateCompanyAggregates. Series are ABS/RBA-derived; attribute the source in the output. Commit: `feat(mcp): economy series tools`.

- [ ] **Task 7 — Politicians (3 tools).** `search_politicians`→ListPoliticians, `get_politician`→GetPolitician, `list_stock_politicians`→ListStockPoliticians.

  **Licence and editorial guards, and tests for them.** Read `docs/feature/politicians/README.md` first. Three rules bind: (a) **what is held, never how much** — no amount/quantity/value field exists in the subsystem and none may appear in a tool's output; (b) APH is CC BY-NC-**ND**, so emit verbatim atoms and never rewrite APH prose; (c) portrait **attribution is a licence obligation** enforced in four places — if a tool emits a portrait it must carry attribution. Write tests for (a) and (c). Commit: `feat(mcp): politician register tools`.

---

### Task 8: Resources and prompts

**Files:** `services/shorts/internal/mcp/resources.go`, `prompts.go`, + tests

- [ ] **Step 1** — Resources: expose the dataset catalog, the glossary and the rate-limit tier table as MCP resources. These are the things an agent needs to *interpret* the tools' output (what "short interest" means, what the T+4 delay implies, what its quota is). Prefer serving content that already exists over authoring new prose.

- [ ] **Step 2** — Prompts: a small set of genuinely useful entry points, e.g. `short_interest_briefing` (arg: ticker), `suburb_housing_brief` (args: state, suburb). Each should compose several tools into an answer shape a human would actually ask for.

- [ ] **Step 3** — Test that resources resolve and prompts render with their arguments substituted.

- [ ] **Step 4** — Commit: `feat(mcp): resources and prompts`.

---

### Task 9: One catalog, one truth — server card and docs

Today `web/src/app/api/agent/mcp-server-card/route.ts` hand-lists 4 tools. Hand-written advertisements drift; Phase 1 hit exactly this with the OpenAPI spec.

**Files:** `services/shorts/internal/mcp/catalog.go`, `serve.go`, `web/src/app/api/agent/mcp-server-card/route.ts`, `web/public/docs/mcp.md`, `web/src/app/docs/mcp.md/route.ts`, `web/src/app/api/mcp/[transport]/route.ts`

- [ ] **Step 1** — `GET /mcp/catalog.json` rendering `Registry()`: name, title, description, domain, input schema. Mount in `serve.go`. Test it lists exactly what `Registry()` holds.

- [ ] **Step 2** — Rewrite the server card to render from that catalog, with the SEP-1649 shape preserved. Update `transport.endpoint` to `https://api.shorted.com.au/mcp` and keep `authentication: {required: false}` (true for Phase 2; Phase 3 revisits). Cache it, and fail soft: if the catalog fetch fails, serve a minimal valid card rather than a 500 — a broken card breaks client discovery.

- [ ] **Step 3** — `/docs/mcp.md`: how to connect (Claude, ChatGPT, generic), the tool catalog, the anonymous-access caveat, and what Phase 3 will add. Follow the `/docs/api.md` route pattern from Phase 1. **Phase 1's markdown generator emits a link to `/docs/mcp`** — make sure the URL it points at is the one that exists.

- [ ] **Step 4** — Turn `web/src/app/api/mcp/[transport]/route.ts` into a deprecation shim: keep it responding, but have every tool result and the server info point at the new endpoint. **Do not delete it** — existing client configs reference it. Note in the report what a client experiences.

- [ ] **Step 5** — Commit: `feat(mcp): publish the tool catalog and connection docs`.

---

### Task 10: Conformance, end-to-end verification, PR

- [ ] **Step 1** — Protocol conformance tests against an in-process SDK client: `server/discover` returns supported versions; `tools/list` matches `Registry()`; `tools/call` returns structured content for a representative tool from each domain; an unknown tool name errors cleanly; an unsupported protocol version produces `UnsupportedProtocolVersionError` listing what we do support.

- [ ] **Step 2** — Run everything: `GOWORK=off go test ./shorts/internal/mcp/... ./pkg/protovisibility/... ./cmd/openapi-postprocess/...`, `node --test scripts/tests/openapi-drift.test.mjs`, and the web tests for the changed routes.

- [ ] **Step 3** — Verify against the locally-running API with a **real MCP client**, not just curl: `server/discover`, `tools/list`, and at least one `tools/call` per domain. Confirm the LISTEN pid is yours first. Record the response sizes — if any tool returns more than ~50KB, revisit its cap.

- [ ] **Step 4** — Open a PR. Do **not** merge; the repo gates agent self-merge. State explicitly in the PR body that Phase 2 is **anonymous and unmetered**, so merging it publishes an unauthenticated tool surface — and that Phase 3 adds OAuth and rate limiting.

---

## Explicitly out of scope

- OAuth 2.1, protected-resource metadata, audience-bound tokens, rate limiting — **all Phase 3**.
- Any write or mutating tool. Read-only.
- Raw crawl listings, declared-interest amounts, aph.gov.au artefacts.
- Retiring the legacy `ShortedStocksService` or deleting the Next.js MCP route.

## Open risks

- **24 tools is at the upper bound of what clients select well over.** If evaluation shows degradation, consolidate behind fewer tools with a `domain` enum rather than adding more.
- **Anonymous and unmetered until Phase 3.** The edge's tier-blind ceiling is the only protection in the interim. If Phase 3 is going to lag, consider gating the mount behind an env flag so the endpoint can be switched off without a rollback.
- **In-process calls skip the interceptor chain.** The visibility guard covers auth. It does **not** cover rate limiting or usage metering — those simply do not happen in Phase 2, by design.
