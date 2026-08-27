# Phase 1: Generated OpenAPI + LLM-Discoverable API Docs — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the two stale, hand-written OpenAPI documents with one generated from the protos covering every public Connect-RPC method, and make it — plus JS-free markdown docs — reachable by an agent from a single URL.

**Architecture:** `buf generate` runs `protoc-gen-connect-openapi` over the 12 domain services to produce a raw OpenAPI 3.1 document. A Go post-processor prunes every method not annotated `VISIBILITY_PUBLIC` (using the same `protoregistry` idiom the auth middleware uses), decorates it with auth/rate-limit/licence metadata, and writes the single canonical artifact consumed by `/docs/api`, `/openapi.json`, the markdown twins and the RFC 9727 catalog. A CI drift test regenerates and diffs.

**Tech Stack:** buf v2, `protoc-gen-connect-openapi` (pinned), Go 1.26, Next.js App Router route handlers, `node --test`.

**Spec:** `docs/superpowers/specs/2026-08-27-mcp-server-and-api-discoverability-design.md` (Part A)

---

## Context an engineer needs before starting

Read these first — they explain constraints that will otherwise look arbitrary:

- **Two specs exist today and both are wrong.** `api/schema/openapi.yaml` (443 lines, 8 paths, last touched years ago) is what `/docs/api` renders via `web/src/lib/openapi/parser.ts:15`. `web/public/openapi.json` (128 lines, 6 paths, 5 of them HTML pages) is what `/.well-known/api-catalog` and `ai-plugin.json` advertise. Neither describes the real API: **64 methods across 12 domain services**.
- **`api/schema/base.yaml` already exists in the exact format `protoc-gen-connect-openapi`'s `base=` option consumes** — per-path `summary`/`description`/`tags` merged onto generated output. It currently only covers legacy paths. It is kept and extended, not deleted.
- **The legacy `shorts.v1alpha1.ShortedStocksService` must NOT be generated.** It duplicates all 64 rpcs of the domain services (that duplication is a deliberate back-compat contract enforced by `proto_parity_test.go`). Generating both would double every path.
- **Visibility is a custom proto extension**, `shortedapi.options.v1.visibility` (field 50000). Methods without it default to auth-required and must not appear in a public spec. The generator's `allowed-visibilities` option keys off `google.api.visibility`, **not** ours — hence the Go post-processor.
- **robots.txt `Disallow`s the RPC paths on purpose.** 56.7% of Googlebot's budget was going there. Do not revert that; we add `Allow` entries for the spec and docs only.
- **`GOWORK=off`** on every Go invocation to match CI.

---

## File Structure

| File | Responsibility |
|---|---|
| `proto/buf.gen.yaml` (modify) | Adds the pinned OpenAPI plugin; raw output only |
| `api/schema/base.yaml` (modify) | Human-written per-path prose + top-level `info`, merged by the generator |
| `api/schema/generated/openapi.yaml` (created by build) | Raw generator output. Committed, but never hand-edited |
| `services/cmd/openapi-postprocess/main.go` (create) | CLI entrypoint: read raw → prune → decorate → write |
| `services/cmd/openapi-postprocess/visibility.go` (create) | Public-method set from `protoregistry` |
| `services/cmd/openapi-postprocess/visibility_test.go` (create) | Tests for the above |
| `services/cmd/openapi-postprocess/transform.go` (create) | Prune + decorate the spec document |
| `services/cmd/openapi-postprocess/transform_test.go` (create) | Tests for the above |
| `web/public/openapi.json` (overwrite) | **The** canonical artifact |
| `web/public/openapi.yaml` (create) | YAML twin |
| `web/src/lib/openapi/parser.ts` (modify) | Repointed at the canonical artifact |
| `web/scripts/generate-api-markdown.mjs` (create) | Spec → markdown twins |
| `web/public/docs/api.md` (generated) | JS-free API reference |
| `web/src/app/docs/api.md/route.ts` (create) | Serves it as `text/markdown` |
| `web/src/app/api/agent/api-catalog/route.ts` (modify) | Adds MCP, llms.txt, YAML spec entries |
| `web/public/.well-known/ai-plugin.json` (modify) | Points at the real spec |
| `web/public/llms.txt`, `llms-full.txt` (modify) | "Programmatic access" section |
| `web/src/app/robots.txt/route.ts` (modify) | `Allow` the spec + docs |
| `web/next.config.mjs` (modify) | `Link` headers on `/docs/*` |
| `.github/workflows/*` (modify) | Drift check |

---

### Task 1: Wire the OpenAPI generator into buf

**Files:**
- Modify: `proto/buf.gen.yaml`
- Modify: `api/schema/base.yaml`
- Create: `api/schema/generated/README.md` (marker so the dir exists)

> **Implemented in `8911d7488`. Two things in the YAML below did not work as written and were corrected during implementation — if you re-run this, use the corrected form:**
> 1. **`services=` must be one `opt` entry per service, not one comma-joined entry.** buf joins `opt` entries with commas, and the plugin splits its whole parameter string on commas first — so services 2..12 arrive as bare unknown params and it exits 1 (`ERROR invalid parameter: shorts.v1alpha1.StockService`). The plugin appends on each `services=` occurrence, so 12 separate entries is the supported form.
> 2. **`strategy: all` is required.** buf's default for a local plugin is `directory`, so the plugin ran once per proto directory, each writing its own `openapi.yaml`; buf kept only the first (7× "duplicate generated file name", a 1.1K near-empty document).
>
> The template stayed at `version: v1` — buf 1.47.2 accepts it, and v1's `path:` takes a list, which is the exact equivalent of v2's `local:`. No migration was needed.

- [ ] **Step 1: Add the plugin to `proto/buf.gen.yaml`**

Append to the `plugins:` list. **Pin the version** — this repo has already been bitten by an unpinned plugin (the Java SDK comment in that same file explains why: unpinned plugins rewrite ~750 files on every regeneration and bury the real change).

`base=` reads a local file, so the remote BSR plugin cannot be used; run the pinned module with `go run`.

```yaml
  # OpenAPI 3.1 for the PUBLIC API surface. Generated raw here, then pruned to
  # VISIBILITY_PUBLIC methods and decorated by
  # services/cmd/openapi-postprocess (the plugin's `allowed-visibilities`
  # option keys off google.api.visibility, not our options.v1 extension).
  #
  # PINNED deliberately — see the Java plugin note above.
  #
  # `services=` excludes the legacy monolithic ShortedStocksService, which
  # duplicates every rpc of the 12 domain services for public-API back-compat.
  # Generating both would double every path in the document.
  - local:
      - go
      - run
      - github.com/sudorandom/protoc-gen-connect-openapi@v0.25.1
    out: ../api/schema/generated
    opt:
      - format=yaml
      - path=openapi.yaml
      - base=../api/schema/base.yaml
      - services=shorts.v1alpha1.MarketService,shorts.v1alpha1.StockService,shorts.v1alpha1.SearchService,shorts.v1alpha1.ScreenerService,shorts.v1alpha1.NewsService,shorts.v1alpha1.ReportsService,shorts.v1alpha1.HousingService,shorts.v1alpha1.EconomyService,shorts.v1alpha1.IndustryIntelligenceService,shorts.v1alpha1.PoliticiansService,shorts.v1alpha1.AlertsService,shorts.v1alpha1.BillingService
      - trim-unused-types
      - short-operation-ids
      - without-default-tags
      - with-proto-annotations
```

- [ ] **Step 2: Replace `api/schema/base.yaml` top matter**

The current file has only `openapi`/`info.x-logo` plus legacy paths. Replace the header (keep any `paths:` entries whose service is still generated; delete the `ShortedStocksService` and `RegisterService` ones — they are no longer generated, and a `base` entry for a path that is not generated is silently dropped, which reads as a bug later).

```yaml
openapi: 3.1.0
info:
  title: Shorted Public API
  version: "1.0.0"
  x-logo:
    url: https://shorted.com.au/logo.png
  description: |
    Programmatic access to Australian market and public-interest data:
    ASIC short positions for ASX-listed securities, Australian house prices
    and suburb metrics, ABS/RBA economic series, and the federal register of
    members' and senators' interests.

    Every endpoint is a Connect-RPC method. Call it with an HTTP POST, a JSON
    body, and the `Connect-Protocol-Version: 1` header:

    ```bash
    curl -X POST https://api.shorted.com.au/shorts.v1alpha1.StockService/GetStock \
      -H 'Content-Type: application/json' \
      -H 'Connect-Protocol-Version: 1' \
      -d '{"productCode":"BHP"}'
    ```

    Authentication is optional for public endpoints; a bearer token raises
    your rate limits. See https://shorted.com.au/docs/api for tiers.
  contact:
    name: Shorted Support
    url: https://shorted.com.au
    email: support@shorted.com.au
  license:
    name: CC BY 4.0
    url: https://creativecommons.org/licenses/by/4.0/
paths: {}
```

- [ ] **Step 3: Create the output directory marker**

```bash
mkdir -p api/schema/generated
printf '# Generated by `buf generate` — never hand-edit.\n' > api/schema/generated/README.md
```

- [ ] **Step 4: Generate and inspect**

Run:
```bash
cd proto && buf generate
```
Expected: `api/schema/generated/openapi.yaml` exists and contains paths for the domain services and **no** `ShortedStocksService` path.

Verify:
```bash
grep -c 'ShortedStocksService' api/schema/generated/openapi.yaml   # expect 0
grep -c '^  /shorts.v1alpha1' api/schema/generated/openapi.yaml    # expect > 40
```

If `buf generate` fails resolving the plugin module, run `GOWORK=off go run github.com/sudorandom/protoc-gen-connect-openapi@v0.25.1 --help` once from `services/` to warm the module cache, then retry.

- [ ] **Step 5: Commit**

```bash
git add proto/buf.gen.yaml api/schema/base.yaml api/schema/generated
git commit -m "build(proto): generate OpenAPI 3.1 from the domain services"
```

---

### Task 2: Public-method registry in Go

Enumerate every method annotated `VISIBILITY_PUBLIC`, keyed by the OpenAPI path the generator emits (`/<service full name>/<method name>`).

**Files:**
- Create: `services/cmd/openapi-postprocess/visibility.go`
- Test: `services/cmd/openapi-postprocess/visibility_test.go`

- [ ] **Step 1: Write the failing test**

```go
package main

import "testing"

func TestPublicMethodPaths(t *testing.T) {
	paths := PublicMethodPaths()

	if len(paths) == 0 {
		t.Fatal("no public methods found — are the generated proto packages imported?")
	}

	// GetStock is annotated VISIBILITY_PUBLIC on the domain service.
	if !paths["/shorts.v1alpha1.StockService/GetStock"] {
		t.Error("expected /shorts.v1alpha1.StockService/GetStock to be public")
	}

	// The legacy monolithic service is excluded wholesale: it duplicates every
	// domain rpc, and generating it would double every path in the document.
	for p := range paths {
		if strings.Contains(p, "ShortedStocksService") {
			t.Errorf("legacy service must be excluded, got %s", p)
		}
	}

	// MintToken issues credentials — it must never be advertised as public.
	if paths["/shorts.v1alpha1.BillingService/MintToken"] {
		t.Error("MintToken must not be public")
	}
}
```

Add `"strings"` to the test imports.

- [ ] **Step 2: Run the test and confirm it fails**

Run:
```bash
cd services && GOWORK=off go test ./cmd/openapi-postprocess/ -run TestPublicMethodPaths -v
```
Expected: FAIL — `undefined: PublicMethodPaths`.

- [ ] **Step 3: Implement**

```go
package main

import (
	optionsv1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/options/v1"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protoreflect"
	"google.golang.org/protobuf/reflect/protoregistry"

	// Blank imports register the descriptors in protoregistry.GlobalFiles.
	// Without them the registry is empty and every method reads as private.
	_ "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
)

// legacyService duplicates every rpc of the 12 domain services for public-API
// back-compat (enforced by proto_parity_test.go). It is excluded here for the
// same reason buf.gen.yaml excludes it: including it doubles every path.
const legacyService = "shorts.v1alpha1.ShortedStocksService"

// PublicMethodPaths returns the set of OpenAPI paths — "/<service>/<method>" —
// for methods annotated VISIBILITY_PUBLIC. Methods with no annotation default
// to auth-required and are therefore absent, matching the auth middleware in
// services/shorts/internal/services/shorts/middleware_connect.go.
func PublicMethodPaths() map[string]bool {
	out := map[string]bool{}

	protoregistry.GlobalFiles.RangeFiles(func(fd protoreflect.FileDescriptor) bool {
		services := fd.Services()
		for i := 0; i < services.Len(); i++ {
			svc := services.Get(i)
			if string(svc.FullName()) == legacyService {
				continue
			}
			methods := svc.Methods()
			for j := 0; j < methods.Len(); j++ {
				m := methods.Get(j)
				vis, _ := proto.GetExtension(m.Options(), optionsv1.E_Visibility).(optionsv1.Visibility)
				if vis != optionsv1.Visibility_VISIBILITY_PUBLIC {
					continue
				}
				out["/"+string(svc.FullName())+"/"+string(m.Name())] = true
			}
		}
		return true
	})

	return out
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run:
```bash
cd services && GOWORK=off go test ./cmd/openapi-postprocess/ -run TestPublicMethodPaths -v
```
Expected: PASS.

If it fails on `MintToken` being public, that is a real finding, not a test bug — report it before changing the test.

- [ ] **Step 5: Commit**

```bash
git add services/cmd/openapi-postprocess/
git commit -m "feat(openapi): enumerate VISIBILITY_PUBLIC methods from the proto registry"
```

---

### Task 3: Prune and decorate the spec

**Files:**
- Create: `services/cmd/openapi-postprocess/transform.go`
- Test: `services/cmd/openapi-postprocess/transform_test.go`

- [ ] **Step 1: Write the failing test**

```go
package main

import "testing"

func specFixture() map[string]any {
	return map[string]any{
		"openapi": "3.1.0",
		// The raw generator output carries the info block from the
		// gnostic.openapi.v3.document option in shorts.proto — NOT from
		// base.yaml, which the plugin applies first and gnostic then
		// overrides. That block asserts a proprietary licence.
		"info": map[string]any{
			"title":   "Shorted API",
			"version": "v1",
			"license": map[string]any{"name": "Proprietary license"},
		},
		"paths": map[string]any{
			"/shorts.v1alpha1.StockService/GetStock": map[string]any{
				"post": map[string]any{"summary": "Get Stock"},
			},
			"/shorts.v1alpha1.BillingService/MintToken": map[string]any{
				"post": map[string]any{"summary": "Mint Token"},
			},
		},
	}
}

func baseFixture() map[string]any {
	return map[string]any{
		"info": map[string]any{
			"title":   "Shorted Public API",
			"version": "1.0.0",
			"license": map[string]any{
				"name": "CC BY 4.0",
				"url":  "https://creativecommons.org/licenses/by/4.0/",
			},
		},
	}
}

func TestTransformStampsInfoFromBase(t *testing.T) {
	spec := specFixture()
	public := map[string]bool{"/shorts.v1alpha1.StockService/GetStock": true}

	if err := Transform(spec, public, baseFixture()); err != nil {
		t.Fatalf("Transform: %v", err)
	}

	info := spec["info"].(map[string]any)
	if info["title"] != "Shorted Public API" {
		t.Errorf("title = %v, want Shorted Public API", info["title"])
	}
	if info["version"] != "1.0.0" {
		t.Errorf("version = %v, want 1.0.0", info["version"])
	}

	// A public API document asserting the wrong licence is a correctness
	// problem, not a cosmetic one: the gnostic option in shorts.proto claims
	// the API is proprietary, and it wins over base.yaml inside the plugin.
	license := info["license"].(map[string]any)
	if license["name"] != "CC BY 4.0" {
		t.Errorf("license = %v, want CC BY 4.0", license["name"])
	}
}

func TestTransformDropsNonPublicPaths(t *testing.T) {
	spec := specFixture()
	public := map[string]bool{"/shorts.v1alpha1.StockService/GetStock": true}

	if err := Transform(spec, public, baseFixture()); err != nil {
		t.Fatalf("Transform: %v", err)
	}

	paths := spec["paths"].(map[string]any)
	if _, ok := paths["/shorts.v1alpha1.StockService/GetStock"]; !ok {
		t.Error("public path was dropped")
	}
	if _, ok := paths["/shorts.v1alpha1.BillingService/MintToken"]; ok {
		t.Error("non-public path survived — it would advertise a credential-issuing endpoint")
	}
}

func TestTransformAddsServersAndSecurity(t *testing.T) {
	spec := specFixture()
	if err := Transform(spec, map[string]bool{"/shorts.v1alpha1.StockService/GetStock": true}, baseFixture()); err != nil {
		t.Fatalf("Transform: %v", err)
	}

	servers, ok := spec["servers"].([]any)
	if !ok || len(servers) != 1 {
		t.Fatalf("expected exactly one server, got %#v", spec["servers"])
	}
	if got := servers[0].(map[string]any)["url"]; got != "https://api.shorted.com.au" {
		t.Errorf("server url = %v, want https://api.shorted.com.au", got)
	}

	comps := spec["components"].(map[string]any)
	schemes := comps["securitySchemes"].(map[string]any)
	if _, ok := schemes["bearerAuth"]; !ok {
		t.Error("bearerAuth security scheme missing")
	}
}

func TestTransformErrorsWhenNoPathsSurvive(t *testing.T) {
	spec := specFixture()
	err := Transform(spec, map[string]bool{}, baseFixture())
	if err == nil {
		t.Fatal("expected an error when every path is pruned — silently shipping an empty spec is worse than failing the build")
	}
}
```

- [ ] **Step 2: Run the test and confirm it fails**

Run:
```bash
cd services && GOWORK=off go test ./cmd/openapi-postprocess/ -run TestTransform -v
```
Expected: FAIL — `undefined: Transform`.

- [ ] **Step 3: Implement**

```go
package main

import "fmt"

// Transform prunes every path not in public and decorates the document with
// the facts the generator cannot know: where the API actually lives, how to
// authenticate, and the rate-limit response headers.
//
// base is the parsed api/schema/base.yaml. Its `info` block is stamped over
// whatever the generator produced, because the plugin applies base= FIRST and
// then lets the file-level gnostic.openapi.v3.document option in shorts.proto
// override it — so the raw output claims `title: Shorted API`, `version: v1`
// and, worst of all, `license: Proprietary license`. Publishing a spec that
// asserts the wrong licence is a correctness problem. Fixing it in the proto
// would rewrite the descriptor bytes and churn every generated Go and TS
// file, so it is corrected here instead.
//
// It mutates spec in place. An empty result is an error: shipping a spec with
// no paths reads to an agent as "this API has no endpoints", which is worse
// than a failed build.
func Transform(spec map[string]any, public map[string]bool, base map[string]any) error {
	paths, ok := spec["paths"].(map[string]any)
	if !ok {
		return fmt.Errorf("spec has no paths object")
	}

	if info, ok := base["info"].(map[string]any); ok {
		spec["info"] = info
	} else {
		return fmt.Errorf("base document has no info block")
	}

	for p := range paths {
		if !public[p] {
			delete(paths, p)
		}
	}
	if len(paths) == 0 {
		return fmt.Errorf("every path was pruned: no VISIBILITY_PUBLIC methods matched the generated document")
	}

	spec["servers"] = []any{
		map[string]any{
			"url":         "https://api.shorted.com.au",
			"description": "Production",
		},
	}

	comps, _ := spec["components"].(map[string]any)
	if comps == nil {
		comps = map[string]any{}
		spec["components"] = comps
	}
	comps["securitySchemes"] = map[string]any{
		"bearerAuth": map[string]any{
			"type":         "http",
			"scheme":       "bearer",
			"description":  "Optional. A Shorted API token raises your rate limits; public endpoints work unauthenticated at the anonymous tier. Manage tokens at https://shorted.com.au/account.",
			"bearerFormat": "JWT",
		},
	}
	// Optional, not required: listing it under a top-level `security` block
	// would tell agents auth is mandatory, which is false and would stop them
	// trying the public endpoints at all.
	spec["security"] = []any{
		map[string]any{"bearerAuth": []any{}},
		map[string]any{},
	}

	spec["x-rate-limit-headers"] = map[string]any{
		"X-RateLimit-Limit":             "Per-minute ceiling for your tier",
		"X-RateLimit-Remaining":         "Requests left in the current minute",
		"X-RateLimit-Reset":             "Unix seconds when the minute window resets",
		"X-RateLimit-Monthly-Limit":     "Monthly quota for your tier",
		"X-RateLimit-Monthly-Remaining": "Requests left this month",
		"X-RateLimit-Detail":            "On a 429, compact JSON describing which limit fired, the ceiling, when it clears, and the upgrade URL",
	}

	return nil
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run:
```bash
cd services && GOWORK=off go test ./cmd/openapi-postprocess/ -v
```
Expected: PASS (all four tests).

- [ ] **Step 5: Commit**

```bash
git add services/cmd/openapi-postprocess/
git commit -m "feat(openapi): prune non-public paths and decorate the generated spec"
```

---

### Task 4: The CLI entrypoint

**Files:**
- Create: `services/cmd/openapi-postprocess/main.go`

- [ ] **Step 1: Implement**

```go
// Command openapi-postprocess turns the raw protoc-gen-connect-openapi output
// into the single canonical OpenAPI document the site serves.
//
// Usage:
//
//	openapi-postprocess -in api/schema/generated/openapi.yaml \
//	  -base api/schema/base.yaml \
//	  -out-json web/public/openapi.json -out-yaml web/public/openapi.yaml
package main

import (
	"encoding/json"
	"flag"
	"log"
	"os"

	"sigs.k8s.io/yaml"
)

func main() {
	in := flag.String("in", "", "raw generated OpenAPI YAML")
	basePath := flag.String("base", "", "api/schema/base.yaml — source of the info block")
	outJSON := flag.String("out-json", "", "canonical JSON output path")
	outYAML := flag.String("out-yaml", "", "canonical YAML output path")
	flag.Parse()

	if *in == "" || *basePath == "" || *outJSON == "" || *outYAML == "" {
		log.Fatal("-in, -base, -out-json and -out-yaml are all required")
	}

	raw, err := os.ReadFile(*in)
	if err != nil {
		log.Fatalf("read %s: %v", *in, err)
	}

	var spec map[string]any
	if err := yaml.Unmarshal(raw, &spec); err != nil {
		log.Fatalf("parse %s: %v", *in, err)
	}

	rawBase, err := os.ReadFile(*basePath)
	if err != nil {
		log.Fatalf("read %s: %v", *basePath, err)
	}

	var base map[string]any
	if err := yaml.Unmarshal(rawBase, &base); err != nil {
		log.Fatalf("parse %s: %v", *basePath, err)
	}

	if err := Transform(spec, PublicMethodPaths(), base); err != nil {
		log.Fatalf("transform: %v", err)
	}

	// Indented JSON so the drift diff is readable line-by-line.
	encoded, err := json.MarshalIndent(spec, "", "  ")
	if err != nil {
		log.Fatalf("encode json: %v", err)
	}
	if err := os.WriteFile(*outJSON, append(encoded, '\n'), 0o644); err != nil {
		log.Fatalf("write %s: %v", *outJSON, err)
	}

	asYAML, err := yaml.Marshal(spec)
	if err != nil {
		log.Fatalf("encode yaml: %v", err)
	}
	if err := os.WriteFile(*outYAML, asYAML, 0o644); err != nil {
		log.Fatalf("write %s: %v", *outYAML, err)
	}

	paths, _ := spec["paths"].(map[string]any)
	log.Printf("wrote %d public paths to %s and %s", len(paths), *outJSON, *outYAML)
}
```

- [ ] **Step 2: Add the YAML dependency**

Run:
```bash
cd services && GOWORK=off go get sigs.k8s.io/yaml@v1.4.0 && GOWORK=off go mod tidy
```

`sigs.k8s.io/yaml` (not `gopkg.in/yaml.v3`) because it round-trips through `encoding/json`, so a document unmarshalled from YAML marshals to JSON with the same key semantics — `yaml.v3` produces `map[any]any`, which `encoding/json` refuses.

- [ ] **Step 3: Run it end-to-end**

Run:
```bash
cd services && GOWORK=off go run ./cmd/openapi-postprocess \
  -in ../api/schema/generated/openapi.yaml \
  -base ../api/schema/base.yaml \
  -out-json ../web/public/openapi.json \
  -out-yaml ../web/public/openapi.yaml
```
Expected: `wrote N public paths to …` with N > 30.

Sanity-check the result:
```bash
grep -c 'MintToken' web/public/openapi.json     # expect 0
python3 -c "import json;d=json.load(open('web/public/openapi.json'));print(len(d['paths']))"
```

- [ ] **Step 4: Commit**

```bash
git add services/cmd/openapi-postprocess/main.go services/go.mod services/go.sum web/public/openapi.json web/public/openapi.yaml
git commit -m "feat(openapi): emit the canonical public API spec"
```

---

### Task 5: One command, and a drift test

**Files:**
- Modify: `Makefile` (root)
- Create: `scripts/tests/openapi-drift.test.mjs`
- Modify: `.github/workflows/repo-hygiene.yml`

- [ ] **Step 1: Add the make target**

Append to the root `Makefile`:

```makefile
.PHONY: openapi
openapi: ## Regenerate the public OpenAPI spec from the protos
	cd proto && buf generate
	cd services && GOWORK=off go run ./cmd/openapi-postprocess \
		-in ../api/schema/generated/openapi.yaml \
		-base ../api/schema/base.yaml \
		-out-json ../web/public/openapi.json \
		-out-yaml ../web/public/openapi.yaml
```

- [ ] **Step 2: Write the failing drift test**

```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

// The spec is generated, and a generated artifact that can drift from its
// source is worse than a hand-written one: it looks authoritative while being
// wrong. Regenerate and diff.
test("web/public/openapi.json is up to date with the protos", () => {
  const before = readFileSync("web/public/openapi.json", "utf8");
  execFileSync("make", ["openapi"], { stdio: "inherit" });
  const after = readFileSync("web/public/openapi.json", "utf8");

  assert.equal(
    after,
    before,
    "openapi.json is stale — run `make openapi` and commit the result",
  );
});

test("the spec advertises no credential-issuing or internal endpoints", () => {
  const spec = JSON.parse(readFileSync("web/public/openapi.json", "utf8"));
  const paths = Object.keys(spec.paths);

  assert.ok(paths.length > 30, `expected a substantial spec, got ${paths.length} paths`);

  for (const forbidden of ["MintToken", "ShortedStocksService", "Admin", "Internal"]) {
    const leaked = paths.filter((p) => p.includes(forbidden));
    assert.deepEqual(leaked, [], `${forbidden} must not appear in the public spec`);
  }
});
```

- [ ] **Step 3: Run it**

Run:
```bash
node --test scripts/tests/openapi-drift.test.mjs
```
Expected: PASS (the artifact was just generated in Task 4).

To confirm the test actually detects drift, corrupt it and re-run:
```bash
echo '{}' > web/public/openapi.json && node --test scripts/tests/openapi-drift.test.mjs
```
Expected: FAIL. Then `make openapi` to restore.

- [ ] **Step 4: Wire into CI**

`repo-hygiene.yml` is the right home, but its existing job has neither Go nor buf. Add a **second job** rather than bloating the Node-only one, and add the new paths to the `on.pull_request.paths` filter:

```yaml
      - "proto/**"
      - "api/schema/**"
      - "scripts/tests/openapi-drift.test.mjs"
```

```yaml
  openapi-drift:
    name: OpenAPI spec is not stale
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v5

      - uses: actions/setup-node@v5
        with:
          node-version: "24"

      - uses: actions/setup-go@v5
        with:
          go-version-file: services/go.mod
          cache-dependency-path: services/go.sum

      - uses: bufbuild/buf-action@v1
        with:
          setup_only: true

      - name: Regenerate and diff
        run: node --test scripts/tests/openapi-drift.test.mjs
```

- [ ] **Step 5: Commit**

```bash
git add Makefile scripts/tests/openapi-drift.test.mjs .github/workflows/
git commit -m "test(openapi): fail the build when the generated spec drifts"
```

---

### Task 6: Converge both consumers on the canonical artifact

Today `/docs/api` reads `api/schema/openapi.yaml` and the catalog advertises `public/openapi.json`. After this task there is one artifact.

**Files:**
- Modify: `web/src/lib/openapi/parser.ts:15`
- Delete: `api/schema/openapi.yaml`

- [ ] **Step 1: Repoint the parser**

Replace the `specPath` assignment:

```typescript
export async function parseOpenAPISpec(): Promise<OpenAPISpec> {
  // The canonical generated artifact — see docs/superpowers/plans/
  // 2026-08-27-phase1-generated-openapi-and-llm-docs.md. Previously this read
  // api/schema/openapi.yaml, a hand-written 8-path document that had drifted
  // years behind the 64-method API.
  const specPath = path.join(process.cwd(), "public", "openapi.json");
```

The existing `fs.existsSync` fallback stays — Docker builds rely on it.

`yaml.load` still parses JSON (JSON is a YAML subset), so the rest of the function is unchanged and `js-yaml` stays a dependency for now.

- [ ] **Step 2: Delete the superseded spec**

```bash
git rm api/schema/openapi.yaml
```

- [ ] **Step 3: Verify the docs page renders the real surface**

Run:
```bash
cd web && npm run dev
```
Then in a second shell:
```bash
curl -s localhost:3020/docs/api | grep -c 'HousingService'
```
Expected: > 0 — housing endpoints now appear, which they never did before.

**Stop the dev server when done.** Confirm the LISTEN pid was yours before trusting the result:
```bash
lsof -nP -iTCP:3020 -sTCP:LISTEN
```

- [ ] **Step 4: Commit**

```bash
git add web/src/lib/openapi/parser.ts api/schema/
git commit -m "refactor(docs): render /docs/api from the generated spec"
```

---

### Task 7: JS-free markdown twins

An agent fetching `/docs/api` gets a React shell. This gives it markdown instead. Follows the existing pattern at `web/src/app/docs/api-reference/route.ts`.

**Files:**
- Create: `web/scripts/generate-api-markdown.mjs`
- Create: `web/src/app/docs/api.md/route.ts`
- Modify: `web/package.json` (script + prebuild hook)

- [ ] **Step 1: Write the generator**

```javascript
#!/usr/bin/env node
// Renders web/public/openapi.json into a JS-free markdown reference at
// web/public/docs/api.md. An agent fetching /docs/api gets a React shell;
// this is what it can actually read.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const spec = JSON.parse(readFileSync(path.join(root, "public/openapi.json"), "utf8"));

const lines = [];
lines.push(`# ${spec.info.title}`, "");
lines.push(spec.info.description ?? "", "");
lines.push("## Base URL", "", "```", spec.servers[0].url, "```", "");

lines.push("## Rate limits", "");
lines.push("| Tier | Per minute | Per month |");
lines.push("| --- | --- | --- |");
lines.push("| anonymous | 30 | 500 |");
lines.push("| free | 60 | 1,000 |");
lines.push("| paid | 120 | 10,000 |");
lines.push("| enterprise | 300 | 50,000 |");
lines.push("");
lines.push(
  "Responses carry `X-RateLimit-*` headers. A 429 carries `X-RateLimit-Detail`:",
  "compact JSON naming which limit fired, the ceiling, when it clears, and the upgrade URL.",
  "",
);

lines.push("## Endpoints", "");
const byTag = new Map();
for (const [route, item] of Object.entries(spec.paths)) {
  const op = item.post;
  if (!op) continue;
  const tag = (op.tags ?? ["Other"])[0];
  if (!byTag.has(tag)) byTag.set(tag, []);
  byTag.get(tag).push({ route, op });
}

for (const [tag, entries] of [...byTag.entries()].sort()) {
  lines.push(`### ${tag}`, "");
  for (const { route, op } of entries.sort((a, b) => a.route.localeCompare(b.route))) {
    lines.push(`#### \`POST ${route}\``, "");
    if (op.summary) lines.push(op.summary, "");
    if (op.description && op.description !== op.summary) lines.push(op.description, "");
    lines.push("```bash");
    lines.push(`curl -X POST ${spec.servers[0].url}${route} \\`);
    lines.push(`  -H 'Content-Type: application/json' \\`);
    lines.push(`  -H 'Connect-Protocol-Version: 1' \\`);
    lines.push(`  -d '{}'`);
    lines.push("```", "");
  }
}

lines.push("## Model Context Protocol", "");
lines.push(
  "An MCP server exposing this data is documented at https://shorted.com.au/docs/mcp",
  "",
);

const outDir = path.join(root, "public/docs");
mkdirSync(outDir, { recursive: true });
writeFileSync(path.join(outDir, "api.md"), lines.join("\n"));
console.log(`wrote public/docs/api.md (${Object.keys(spec.paths).length} endpoints)`);
```

The MCP line is written now and becomes true in Phase 2. If Phase 2 is not going to land, drop those three lines rather than shipping a dead link.

- [ ] **Step 2: Add the npm scripts**

In `web/package.json` `"scripts"`:

```json
    "docs:api-markdown": "node scripts/generate-api-markdown.mjs",
```

- [ ] **Step 3: Run it**

Run:
```bash
cd web && npm run docs:api-markdown
```
Expected: `wrote public/docs/api.md (N endpoints)` with N matching the spec.

- [ ] **Step 4: Serve it**

Create `web/src/app/docs/api.md/route.ts` — same shape as the existing `api-reference` route:

```typescript
import { readFile } from "fs/promises";
import { NextResponse } from "next/server";
import path from "path";

// JS-free markdown twin of /docs/api, generated from the canonical OpenAPI
// document by web/scripts/generate-api-markdown.mjs. Agents that cannot
// execute JavaScript get the real content here.
export async function GET() {
  try {
    const filePath = path.join(process.cwd(), "public", "docs", "api.md");
    const content = await readFile(filePath, "utf-8");

    return new NextResponse(content, {
      status: 200,
      headers: {
        "Content-Type": "text/markdown; charset=utf-8",
        "Cache-Control": "public, max-age=3600, s-maxage=3600",
        "X-Robots-Tag": "index, follow",
        "X-LLM-Friendly": "true",
        "X-AI-Indexable": "true",
        Link: '</openapi.json>; rel="service-desc"; type="application/json", </docs/api>; rel="alternate"; type="text/html"',
      },
    });
  } catch {
    return NextResponse.json({ error: "Documentation not found" }, { status: 404 });
  }
}
```

- [ ] **Step 5: Verify**

Run:
```bash
cd web && npm run dev
curl -si localhost:3020/docs/api.md | head -20
```
Expected: `200`, `Content-Type: text/markdown`, and markdown in the body. Stop the dev server.

- [ ] **Step 6: Commit**

```bash
git add web/scripts/generate-api-markdown.mjs web/src/app/docs/api.md web/package.json web/public/docs/api.md
git commit -m "feat(docs): JS-free markdown twin of the API reference"
```

---

### Task 8: Point the discovery spine at the truth

The spine exists and is correct in shape; every document behind it is stale.

**Files:**
- Modify: `web/src/app/api/agent/api-catalog/route.ts`
- Modify: `web/public/.well-known/ai-plugin.json`
- Modify: `web/public/llms.txt`
- Modify: `web/src/app/robots.txt/route.ts`
- Modify: `web/next.config.mjs`
- Test: `web/src/app/api/agent/__tests__/api-catalog.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { GET as catalogGet } from "../api-catalog/route";

describe("RFC 9727 api-catalog", () => {
  it("advertises the spec, the docs, the markdown twin and llms.txt", async () => {
    const res = catalogGet();
    const body = await res.json();
    const entry = body.linkset[0];

    const hrefs = JSON.stringify(entry);

    expect(hrefs).toContain("/openapi.json");
    expect(hrefs).toContain("/openapi.yaml");
    expect(hrefs).toContain("/docs/api.md");
    expect(hrefs).toContain("/llms.txt");
  });

  it("is served as application/linkset+json", () => {
    const res = catalogGet();
    expect(res.headers.get("Content-Type")).toContain("application/linkset+json");
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run:
```bash
cd web && npx jest src/app/api/agent/__tests__/api-catalog.test.ts
```
Expected: FAIL — the catalog currently lists only `openapi.json`, `/docs/api` and health.

- [ ] **Step 3: Extend the catalog**

Replace the `catalog` object in `web/src/app/api/agent/api-catalog/route.ts`:

```typescript
  const catalog = {
    linkset: [
      {
        anchor: `${base}/api/`,
        "service-desc": [
          {
            href: `${base}/openapi.json`,
            type: "application/json",
            title: "Shorted Public API — OpenAPI 3.1 description",
          },
          {
            href: `${base}/openapi.yaml`,
            type: "application/yaml",
            title: "Shorted Public API — OpenAPI 3.1 description (YAML)",
          },
        ],
        "service-doc": [
          {
            href: `${base}/docs/api`,
            type: "text/html",
            title: "Shorted API documentation",
          },
          {
            href: `${base}/docs/api.md`,
            type: "text/markdown",
            title: "Shorted API documentation (markdown, no JavaScript required)",
          },
        ],
        describedby: [
          {
            href: `${base}/llms.txt`,
            type: "text/plain",
            title: "Site and dataset overview for language models",
          },
          {
            href: `${base}/llms-full.txt`,
            type: "text/plain",
            title: "Extended site and dataset documentation for language models",
          },
        ],
        status: [{ href: `${base}/api/health` }],
      },
    ],
  };
```

- [ ] **Step 4: Run the test and confirm it passes**

Run:
```bash
cd web && npx jest src/app/api/agent/__tests__/api-catalog.test.ts
```
Expected: PASS.

- [ ] **Step 5: Fix `ai-plugin.json`**

In `web/public/.well-known/ai-plugin.json`, change the `api` block and add the docs pointer. The `url` currently advertises the spec that this plan replaced, so no edit is needed there — but the description is wrong about scope now that housing, economy and politicians are in the spec:

```json
  "description_for_model": "Shorted.com.au provides Australian market and public-interest data: official ASIC short position data for ASX-listed securities (T+4 delay, 2010 to present), Australian house prices and suburb metrics, ABS/RBA economic series by state, and the federal register of members' and senators' interests. Every endpoint is a Connect-RPC method — HTTP POST with a JSON body and a Connect-Protocol-Version: 1 header. The full machine-readable description is at https://shorted.com.au/openapi.json and a JavaScript-free reference at https://shorted.com.au/docs/api.md.",
```

- [ ] **Step 6: Add the "Programmatic access" section to `llms.txt`**

Insert after the `## Key Content` list:

```markdown
## Programmatic access

- [OpenAPI 3.1 description](https://shorted.com.au/openapi.json): Machine-readable description of every public endpoint. YAML twin at /openapi.yaml.
- [API reference (markdown)](https://shorted.com.au/docs/api.md): JavaScript-free reference with worked curl examples.
- [API catalog (RFC 9727)](https://shorted.com.au/.well-known/api-catalog): Link set pointing at everything on this list.

Every endpoint is a Connect-RPC method. Call it with an HTTP POST, a JSON body,
and the `Connect-Protocol-Version: 1` header:

    curl -X POST https://api.shorted.com.au/shorts.v1alpha1.StockService/GetStock \
      -H 'Content-Type: application/json' \
      -H 'Connect-Protocol-Version: 1' \
      -d '{"productCode":"BHP"}'

Authentication is optional: public endpoints work unauthenticated at the
anonymous tier (30 requests/minute, 500/month). A bearer token raises those
limits — see https://shorted.com.au/docs/api.md#rate-limits.
```

Mirror the same section into `web/public/llms-full.txt`.

- [ ] **Step 7: Allow the new surfaces in robots.txt**

In `web/src/app/robots.txt/route.ts`, add to `AI_ALLOWED_PATHS`:

```typescript
  "/openapi.json",
  "/openapi.yaml",
  "/.well-known/",
```

`/docs/` is already present. **Do not touch `RPC_PATHS`** — that `Disallow` is load-bearing crawl-budget protection (56.7% of Googlebot's budget was going to RPC paths), and the comment above it explains why removing it is safe only in the direction we are not going.

Note `PRIVATE_PATHS` contains `/api/` and the catalog is *rewritten* from `/.well-known/api-catalog` to `/api/agent/api-catalog` — the crawler only ever sees the `/.well-known/` URL, so the `Allow` above is sufficient and the `Disallow: /api/` stays.

- [ ] **Step 8: Extend the `Link` header to the docs routes**

In `web/next.config.mjs` `headers()`, add a second entry alongside the existing `source: "/"` block:

```javascript
      {
        source: "/docs/:path*",
        headers: [
          {
            key: "Link",
            value:
              '</.well-known/api-catalog>; rel="api-catalog", </openapi.json>; rel="service-desc"; type="application/json", </docs/api.md>; rel="alternate"; type="text/markdown"',
          },
        ],
      },
```

- [ ] **Step 9: Add `WebAPI` JSON-LD to the docs page**

Create `web/src/@/components/seo/web-api-schema.tsx`, following the existing pattern in `web/src/@/components/seo/structured-data.tsx`:

```tsx
/**
 * Schema.org WebAPI markup for the public API. Gives crawlers and agents a
 * structured pointer to the machine-readable description, which prose alone
 * does not.
 */
export function WebApiSchema() {
  const schema = {
    "@context": "https://schema.org",
    "@type": "WebAPI",
    name: "Shorted Public API",
    description:
      "Programmatic access to ASIC short position data for ASX-listed securities, Australian house prices and suburb metrics, ABS/RBA economic series, and the federal register of members' and senators' interests.",
    url: "https://shorted.com.au/docs/api",
    documentation: "https://shorted.com.au/docs/api.md",
    provider: {
      "@type": "Organization",
      name: "Shorted",
      url: "https://shorted.com.au",
    },
    termsOfService: "https://shorted.com.au/terms",
    license: "https://creativecommons.org/licenses/by/4.0/",
    potentialAction: {
      "@type": "ConsumeAction",
      target: "https://api.shorted.com.au",
    },
  };

  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(schema) }}
    />
  );
}
```

Render it from `web/src/app/docs/api/page.tsx` — add the import and place `<WebApiSchema />` as the first child of the outermost `<div>`:

```tsx
import { WebApiSchema } from "~/@/components/seo/web-api-schema";
```

- [ ] **Step 10: Run the full frontend test suite**

Run:
```bash
cd web && npm test
```
Expected: PASS. If `robots-rpc-disallow.test.ts` fails, you changed `RPC_PATHS` — revert that.

- [ ] **Step 11: Commit**

```bash
git add web/src/app/api/agent/ web/public/.well-known/ai-plugin.json web/public/llms.txt web/public/llms-full.txt web/src/app/robots.txt/route.ts web/next.config.mjs web/src/@/components/seo/web-api-schema.tsx web/src/app/docs/api/page.tsx
git commit -m "feat(docs): point the discovery spine at the generated spec and markdown docs"
```

---

### Task 9: End-to-end verification

- [ ] **Step 1: Regenerate everything from clean**

Run:
```bash
make openapi && cd web && npm run docs:api-markdown && git status --short
```
Expected: no unexpected modifications — the committed artifacts already match.

- [ ] **Step 2: Run the gates**

Run:
```bash
task verify
node --test scripts/tests/openapi-drift.test.mjs
cd services && GOWORK=off go test ./cmd/openapi-postprocess/...
```
Expected: all PASS.

- [ ] **Step 3: Walk the discovery path as an agent would**

Start the dev server, then follow the chain from one URL — this is the actual acceptance criterion for Part A:

```bash
cd web && npm run dev
lsof -nP -iTCP:3020 -sTCP:LISTEN   # confirm the pid is yours before trusting anything

curl -si localhost:3020/ | grep -i '^link:'
curl -s localhost:3020/.well-known/api-catalog | python3 -m json.tool
curl -s localhost:3020/openapi.json | python3 -c "import json,sys; print(len(json.load(sys.stdin)['paths']), 'paths')"
curl -s localhost:3020/docs/api.md | head -40
```

Expected: the `Link` header names the catalog; the catalog names the spec, the markdown docs and llms.txt; the spec has 30+ paths; the markdown is readable prose with curl examples. Stop the dev server.

- [ ] **Step 4: Open the PR**

```bash
git push -u origin feat/mcp-server-and-api-discovery
gh pr create --title "feat(docs): generated OpenAPI + LLM-discoverable API documentation" \
  --body "Phase 1 of docs/superpowers/specs/2026-08-27-mcp-server-and-api-discoverability-design.md"
```

Do **not** merge — the repo gates agent self-merge; hand the merge to the user.

---

## Deferred to later phases

- **Phase 2** — the MCP server in Go (`services/shorts/internal/mcp`), ~22 tools, protocol 2026-07-28, mounted at `api.shorted.com.au/mcp`; `/docs/mcp.md`; server card generated from the tool registry.
- **Phase 3** — OAuth 2.1 authorization server in Next.js, RFC 9728 protected-resource metadata in Go, audience-bound tokens, `ratelimit.HTTPMiddleware`, Cloudflare worker bucket classification, and the OAuth migration (hand-applied to prod first).

Per-endpoint markdown files (`/docs/api/<endpoint>.md`) are deliberately **not** in this phase: `api.md` plus the OpenAPI document already give an agent everything, and 60+ generated pages is crawl-budget spend with no reader.
