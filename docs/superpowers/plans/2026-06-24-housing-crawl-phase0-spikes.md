# Housing Crawl — Phase 0 Gating Spikes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve the two unknowns that gate the whole residential-housing-crawl effort — (a) can we fetch *clean, validation-passing* REA/Domain suburb data from a residential IP, and (b) which states publish machine-readable suburb medians — and capture the real HTML fixtures + source facts the downstream build plans need.

**Architecture:** Two parallel investigations run from the user's **residential** dev machine (same IP class as the eventual mac-rig runner). The feasibility spike uses the in-repo `stealth` CLI + the existing collector crawl code; the source-verification spike hits each state's open-data portal. Outputs are saved as fixtures + a findings doc that feed the build plans.

**Tech Stack:** Go (collector + stealth CLI), `stealth fetch` CLI (`~/projects/stealth`), the existing `services/house-price-collector` crawl tier, government open-data portals (CKAN / Socrata / XLSX).

**Authorization note:** The user has explicitly authorized scraping REA/Domain ("just scrape … just get the data"). Keep feasibility fetches **tiny and polite** — a handful of pages, with the existing 5–15s jitter — this is a feasibility probe, not a harvest.

---

## Pre-flight

**Files:**
- Worktree: `~/projects/shorted-housing-crawl` (branch `feat/residential-housing-crawl`, off `origin/main`)
- Stealth CLI: `~/projects/stealth`
- Fixtures dir (create): `~/projects/shorted-housing-crawl/services/house-price-collector/testdata/fixtures/`
- Findings doc (create): `docs/superpowers/specs/2026-06-24-phase0-findings.md`

- [ ] **Step 1: Confirm the dev machine's egress IP is residential (not VPN/datacenter)**

Run:
```bash
curl -s https://ipinfo.io/json | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d.get("ip"), d.get("org"), d.get("city"))'
```
Expected: an ISP/telco org (e.g. Telstra/TPG/Aussie BB), **not** Google/AWS/DigitalOcean/a VPN. If it shows a VPN/datacenter org, STOP — disable the VPN or move to the mac rig first; a non-residential IP invalidates the whole spike. Record the org in the findings doc.

- [ ] **Step 2: Confirm the stealth CLI builds and Chrome is present**

Run:
```bash
cd ~/projects/stealth && go build -o /tmp/stealth-cli ./cmd/stealth 2>&1 | tail -5 && /tmp/stealth-cli --help 2>&1 | head -20
ls -la "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" 2>/dev/null && echo "Chrome present"
```
Expected: a `stealth` CLI binary with a `fetch` subcommand; Chrome binary present (needed for the chromium engine leg). If the CLI subcommand names differ, note the actual `fetch`/engine flags from `--help`.

- [ ] **Step 3: Create the fixtures + findings scaffolding**

Run:
```bash
mkdir -p ~/projects/shorted-housing-crawl/services/house-price-collector/testdata/fixtures
```
Create `docs/superpowers/specs/2026-06-24-phase0-findings.md` with headings: `## Egress IP`, `## REA feasibility`, `## Domain feasibility`, `## Go/No-Go`, `## Open-VG sources`. Commit the scaffold:
```bash
cd ~/projects/shorted-housing-crawl && git add docs/superpowers/specs/2026-06-24-phase0-findings.md && git commit --no-verify -m "docs(housing): phase-0 findings scaffold"
```

---

## Task 1: REA (realestate.com.au / Kasada) feasibility

**Files:**
- Capture: `services/house-price-collector/testdata/fixtures/rea-<suburb>.html`
- Findings: `docs/superpowers/specs/2026-06-24-phase0-findings.md` → `## REA feasibility`

The collector builds REA URLs as `https://www.realestate.com.au/neighbourhoods/{suburb}-{postcode}-{state}` (`crawl_targets.go` `reaURL()`). Use a seed suburb (Bondi 2026 NSW).

- [ ] **Step 1: Native-engine fetch (cheap TLS-spoof path)**

Run:
```bash
/tmp/stealth-cli fetch -e native 'https://www.realestate.com.au/neighbourhoods/bondi-2026-nsw' -o /tmp/rea-native.html 2>&1 | tail -20
wc -c /tmp/rea-native.html; head -c 400 /tmp/rea-native.html
```
Observe: HTTP status, body size, and whether the body is a Kasada interstitial / `<title>` is a challenge page vs a real suburb page. Record status + verdict (clean / blocked / poisoned) in findings.

- [ ] **Step 2: Chromium-engine fetch (escalation path)**

Run:
```bash
/tmp/stealth-cli fetch -e chromium 'https://www.realestate.com.au/neighbourhoods/bondi-2026-nsw' -o /tmp/rea-chromium.html 2>&1 | tail -20
wc -c /tmp/rea-chromium.html; grep -o '__NEXT_DATA__\|__INITIAL_STATE__\|medianPrice\|"median"' /tmp/rea-chromium.html | sort | uniq -c
```
Observe: does the chromium page contain real data markers (`__NEXT_DATA__`/`medianPrice`/etc)? Record which engine (if either) returns real data.

- [ ] **Step 3: Run the existing extractor + validation gates against the captured HTML**

The collector already extracts candidate medians schema-agnostically (`crawl_extract.go` `extractSaleMedians`) and validates them (`crawl_validate.go`). Write a throwaway harness to confirm the captured HTML yields a plausible, validation-passing median:
```bash
cd ~/projects/shorted-housing-crawl/services && cat > /tmp/extract_probe.go <<'EOF'
//go:build ignore
package main
// Probe: load a captured fixture, run extractSaleMedians + validateMedian, print results.
// (Fill from crawl_extract.go/crawl_validate.go exported-or-copied helpers; if unexported,
//  add a temporary _test.go in package main that calls them and run `go test -run Probe -v`.)
EOF
echo "Implement the probe as a *_test.go in the house-price-collector package calling extractSaleMedians(string(html)) and validateMedian(...) — these are package-private, so a test in-package is the clean way."
```
Concretely: add `services/house-price-collector/crawl_probe_test.go` (package `main`) that reads `/tmp/rea-chromium.html`, calls `extractSaleMedians(string(b))`, prints candidates, and asserts at least one passes `validateMedian` against Bondi's plausible band. Run:
```bash
cd ~/projects/shorted-housing-crawl/services && go test ./house-price-collector/ -run Probe -v 2>&1 | tail -30
```
Expected: ≥1 extracted median in a sane Bondi range (~$2–4M). Record the extracted value(s) + whether validation passed.

- [ ] **Step 4: Save the winning HTML as a fixture (only if real, non-poisoned)**

Run (use whichever engine returned real data):
```bash
cp /tmp/rea-chromium.html ~/projects/shorted-housing-crawl/services/house-price-collector/testdata/fixtures/rea-bondi-2026-nsw.html
```
This fixture is the TDD input for the brandbrain `ExtractRealEstate` build plan. If REA was blocked/poisoned on **both** engines, do NOT save a poisoned fixture — record "REA blocked from residential IP" in findings (this flips the Phase-0 gate toward the managed-unblocker escalation).

- [ ] **Step 5: Commit findings + fixture**

```bash
cd ~/projects/shorted-housing-crawl && git add services/house-price-collector/testdata/fixtures docs/superpowers/specs/2026-06-24-phase0-findings.md && git commit --no-verify -m "spike(housing): REA residential feasibility result + fixture"
```

---

## Task 2: Domain (domain.com.au / Akamai) feasibility

**Files:**
- Capture: `services/house-price-collector/testdata/fixtures/domain-<suburb>.html`
- Findings: `## Domain feasibility`

Domain URL shape (`crawl_targets.go` `domainURL()`): `https://www.domain.com.au/suburb-profile/{suburb}-{state}-{postcode}`.

- [ ] **Step 1: Native + chromium fetch**

Run:
```bash
/tmp/stealth-cli fetch -e native   'https://www.domain.com.au/suburb-profile/bondi-nsw-2026' -o /tmp/dom-native.html   2>&1 | tail -10; wc -c /tmp/dom-native.html
/tmp/stealth-cli fetch -e chromium 'https://www.domain.com.au/suburb-profile/bondi-nsw-2026' -o /tmp/dom-chromium.html 2>&1 | tail -10; wc -c /tmp/dom-chromium.html
grep -o '__NEXT_DATA__\|__INITIAL_STATE__\|medianPrice\|"median"' /tmp/dom-chromium.html | sort | uniq -c
```
Record status + clean/blocked verdict per engine.

- [ ] **Step 2: Extractor + validation probe**

Extend `crawl_probe_test.go` to also load `/tmp/dom-chromium.html` and run `extractSaleMedians` + `validateMedian`. Run:
```bash
cd ~/projects/shorted-housing-crawl/services && go test ./house-price-collector/ -run Probe -v 2>&1 | tail -30
```
Expected: ≥1 plausible Bondi median, validation passing. Record results.

- [ ] **Step 3: Save fixture (only if real) + commit**

```bash
cp /tmp/dom-chromium.html ~/projects/shorted-housing-crawl/services/house-price-collector/testdata/fixtures/domain-bondi-nsw-2026.html
cd ~/projects/shorted-housing-crawl && git add services/house-price-collector/testdata/fixtures docs/superpowers/specs/2026-06-24-phase0-findings.md && git commit --no-verify -m "spike(housing): Domain residential feasibility result + fixture"
```

---

## Task 3: Phase-0 Go/No-Go decision

**Files:** `docs/superpowers/specs/2026-06-24-phase0-findings.md` → `## Go/No-Go`

- [ ] **Step 1: Record the decision against explicit criteria**

Write the verdict using these criteria:
- **GO (proceed with the cuttlefish home-runner architecture):** at least one of REA/Domain returns clean, validation-passing suburb data from the residential IP (chromium acceptable). The mac-rig runner will reproduce this.
- **PARTIAL:** one site works, the other is blocked → proceed for the working site; record the blocked one as a managed-unblocker candidate.
- **NO-GO (escalate before building):** both sites blocked/poisoned even from residential IP → STOP the cuttlefish-runner build; the design pivots to a managed unblocker (Bright Data/Oxylabs Web Unlocker) wired into `stealthhttp`. Surface this to the user — it's a cost/architecture fork.

- [ ] **Step 2: Commit the decision and surface it**

```bash
cd ~/projects/shorted-housing-crawl && git add docs/superpowers/specs/2026-06-24-phase0-findings.md && git commit --no-verify -m "spike(housing): phase-0 go/no-go decision"
```
Report the verdict to the user before starting any Phase-2/3 build plan.

---

## Task 4: Open-VG source verification (NSW, QLD, WA, TAS, ACT, NT)

**Files:** `docs/superpowers/specs/2026-06-24-phase0-findings.md` → `## Open-VG sources`

This is independent of the REA/Domain gate (open-gov data, datacenter egress fine) and can run in parallel. For each state, find a **machine-readable suburb-level median** source, or record that none exists. Two confirmed in-repo patterns to match: CKAN datastore JSON (`sa_vg.go`) and Cloudflare-walled XLSX (`vic_vpsr.go`).

- [ ] **Step 1: Probe each state's portal**

For each state, identify the canonical source and confirm it returns suburb medians. Starting points to verify (do NOT assume — confirm the live URL + format + licence):
- **NSW:** Valuer-General PSI bulk property sales (`valuation.property.nsw.gov.au`) and/or `data.nsw.gov.au` CKAN. NSW PSI is bulk `.DAT`/zip, not CKAN-friendly — confirm.
- **QLD:** `data.qld.gov.au` CKAN "property sales data" / DNRME median-sale tables.
- **WA:** Landgate / `data.wa.gov.au` median-house-price-by-suburb (CKAN).
- **TAS:** `data.thelist.tas.gov.au` / Treasury property-sales (often XLSX).
- **ACT:** `data.act.gov.au` (Socrata) residential-property-sales (districts, not suburbs).
- **NT:** `data.nt.gov.au` property-sales (smallest; may be PDF/XLSX only).

For each, run a quick reachability + shape check, e.g. for a CKAN candidate:
```bash
curl -s 'https://data.<state>.gov.au/api/3/action/package_search?q=property+sales+median+suburb' | python3 -c 'import sys,json; d=json.load(sys.stdin); [print(r["name"], "|", [res["format"] for res in r.get("resources",[])]) for r in d["result"]["results"][:5]]'
```

- [ ] **Step 2: Record a verification table**

For each state record: **source URL**, **format** (CKAN-JSON / Socrata / XLSX / DAT / PDF / none), **granularity** (suburb / LGA / district), **licence** (CC-BY? other), **ingest pattern to reuse** (sa_vg-style / vic_vpsr-style / new), and **verdict** (machine-readable ✓ / best-effort / drop). Be explicit about any state with no machine-readable suburb medians — those get dropped with a logged note (no silent gaps).

- [ ] **Step 3: Commit the source table**

```bash
cd ~/projects/shorted-housing-crawl && git add docs/superpowers/specs/2026-06-24-phase0-findings.md && git commit --no-verify -m "spike(housing): open-VG per-state source verification"
```

---

## Outputs that unblock the build plans

When this plan completes we will have:
1. **A Phase-0 verdict** → decides whether the cuttlefish-runner build proceeds or we escalate to a managed unblocker.
2. **Real REA/Domain HTML fixtures** → the TDD inputs for the brandbrain `ExtractRealEstate` build plan (so the real-estate langextract schema + `__NEXT_DATA__` parser are built against *real* markup, not guesses).
3. **A verified per-state source table** → the concrete inputs for the open-VG ingest build plan (real URLs/formats/licences, no placeholders).

## Build plans to write next (gated on this plan's outputs)

- **Plan B — brandbrain `ExtractRealEstate`** (proto + real-estate schema + `__NEXT_DATA__` parser + Schema.org widening + registration test). Written against the captured fixtures. *Gated on: Task 3 = GO/PARTIAL.*
- **Plan A — cuttlefish residential pipeline** (wire cron + declarative runner pinning + tests; register mac-rig runner; Workflow + TaskPackage; chromium crawl image). *Gated on: Task 3 = GO/PARTIAL.*
- **Plan C — open-VG backbone** (per-state ingesters → `runOfficial`). Written against the verified source table. *Independent — can proceed regardless of the gate.*
- **Plan D — shorted crawl integration + web hygiene** (forward bytes → brandbrain → validate → store segregated; enforce `source_licence` gate; fix state-filter bug). *Gated on: Plans A + B.*
