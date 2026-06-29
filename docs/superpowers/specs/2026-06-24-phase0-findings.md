# Phase-0 Findings — Residential Feasibility + Open-VG Source Verification

**Date:** 2026-06-24
**Verified from:** dev machine, egress `119.15.78.0` / **AS38195 Superloop** (Australian ISP, Adelaide) — confirmed **residential**, not VPN/datacenter. Same IP class as the eventual mac-rig runner.

## Gate decision: **GO (full)** — with a tooling pivot

Both REA (Kasada) and Domain (Akamai) return **complete suburb data from the residential IP** — *but only via a properly-driven real browser*. The stealth engine's browser path is broken and must be replaced/fixed.

### REA (realestate.com.au — Kasada)

| Path | Result |
|---|---|
| stealth `native` (HTTP + uTLS) | **Blocked** — 714 B Kasada interstitial (`window.KPSDK={}`) |
| stealth `chromium` | **Blocked** — 758 B Kasada stub (no real browser launched / no wait) |
| stealth `chromium-stealth` | **Blocked** — 758 B stub; logs show FSM bug `no transition from detecting on event complete`; example.com control returns only 544 B (not full DOM) |
| **real browser (Playwright, 8 s wait)** | GO — redirects to `/nsw/bondi-2026/`, renders 537 KB with `__NEXT_DATA__`/ArgonautExchange. Extracted: **median house $4,275,000, unit $1,457,500**, rental yield 2.3%/4.0%, rent $1,800/$1,000 PW, annual growth 3.6%/3.4%, median days-on-market, 5-yr trend series |

### Domain (domain.com.au — Akamai)

| Path | Result |
|---|---|
| stealth `native` | **Blocked** — 563 B Akamai "Access Denied" |
| stealth `chromium` | **Blocked** — 2,580 B Akamai challenge page |
| **real browser (Playwright, 8 s wait)** | GO — 456 KB, `digitalData` embedded, median table (BEDROOMS / TYPE / MEDIAN PRICE / AVG DAYS ON MARKET / CLEARANCE RATE / SOLD THIS YEAR): house medians $3.36m–$4.77m, units $1.0m–$2.11m, rents, clearance, listings |

### Pivot (changes the implementation plan)

The approved architecture (cuttlefish runner running the collector's **stealth-engine** crawl) is **valid on residential IP but blocked by the stealth engine's broken browser path.** The crawl must drive a **real browser** (Playwright / a fixed chromedp flow) that:
1. waits for the JS challenge to execute + the redirect/network-idle, then
2. captures the fully-rendered DOM (537 KB / 456 KB with embedded JSON state).

This is a concrete **dogfood finding for stealth** (the shared engine brandbrain also uses): `chromium-stealth` errors in its FSM, doesn't wait for challenge resolution, and returns the pre-challenge stub instead of the rendered page.

## Open-VG source verification (public tier)

| State | Open suburb medians? | Source | Verdict |
|---|---|---|---|
| **SA** | yes (shipped) | data.sa.gov.au CKAN | done |
| **VIC** | yes (shipped) | land.vic Valuer-General XLSX | done |
| **NSW** | best-effort | VG **PSI bulk DAT** (raw transactions -> aggregate ourselves; session-cookie + pacing; **licence ambiguous** — bundled file says CC-BY, pages say BY-NC-ND) | **add (new `nsw_vg-PSI` pattern), confirm licence** |
| **QLD** | none | QVAS sales is **paid** ($20k quote); open data has only capital-city HPI + LGA land valuations | drop (open); crawl-only |
| **WA** | none open | Landgate custom-licence/paid, SLIP OAuth-gated. **REIWA** suburb pages ARE machine-readable JSON (median house/unit/land, quartiles, by-bedroom, counts) but **proprietary** | drop (open); **crawl-tier candidate (REIWA)** |
| **TAS** | none | LIST report is per-property PDF, paid/copyright; REIT proprietary | drop (open); crawl-only |
| **ACT** | none | Socrata has no property data; only a copyright PDF w/ ~9 greenfield LAND suburbs. ABS GCCSA = whole-of-Canberra already covered | drop |
| **NT** | none anywhere | No dataset exists; REINT region-level only | drop |

### Implication

The public open tier realistically gains **only NSW** (effortful, licence caveat). **QLD, WA, TAS, ACT, NT have no open suburb-median source at all** — for those, suburb-level data is available **only via the internal, ToS-gated REA/Domain (and WA: REIWA) crawl.** This makes the residential crawl the *de-facto suburb data source for half the country* — consistent with the acquire-only/internal directive.

## Net effect on the plan

- **Plan A/D (residential crawl):** GO — but swap the fetch mechanism from the stealth engine to a **real browser driver** (decision fork). brandbrain gets the full rendered HTML (excellent langextract input).
- **Plan C (open-VG):** scope shrinks from "6 states" to **NSW only** (best-effort) + a possible REIWA crawl-tier item for WA.
- **Stealth:** new finding — `chromium-stealth` engine is broken (FSM + no challenge wait + truncated DOM). Fixing it is the "improve the shared engine" option.
