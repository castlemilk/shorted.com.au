# Shorted Roadmap

Two parallel tracks:
- **Track A — Influence layer** ("shadow data"): money in politics, contracts,
  tax, MP interests, cross-linked on an ABN entity spine.
- **Track B — Financial perspective**: bear-vs-bull products, fundamentals,
  macro/sector context, housing calculators.

# Track A — The "Shadow Data" Influence Layer

> Positioning: **"The data Australia's institutions publish but hope you won't read."**
> Shorts (ASIC) was the first shadow dataset, housing (ABS/RBA) the second. This
> roadmap builds the third: an **Influence layer** — money in politics, government
> contracts, corporate tax, and politicians' private interests — cross-linked on an
> ABN/ACN entity spine and joined to the market data nobody else has.
>
> Differentiator: every existing transparency project (Open Politics, AusTender
> analysts, tax-report journalism) is a silo. Shorted joins them to each other AND
> to short positions / prices / director trades / news.

## Phase 0 — Foundations (shared infrastructure)

- [ ] **ABN entity spine**: ingest the free ABN Lookup bulk extract; new table
      mapping ABN/ACN ↔ entity name ↔ ASX code (extend `company-metadata` with
      `abn`). This is the join key for every dataset below.
- [ ] **Entity resolution pass**: fuzzy-match ATO/AEC/AusTender entity names to
      ABNs where the source lacks them; store match confidence. Set-based SQL where
      possible (see graph-backfill landmines in memory).
- [x] **Editorial-standards doc** (`docs/influence-editorial-standards.md`):
      defamation posture — primary-source facts + citations only, juxtaposition not
      imputation, never attach "corruption" to a named entity. Australia is the most
      plaintiff-friendly defamation jurisdiction in the anglosphere; truth is a
      defence, imputation is the risk.
- [x] **Licensing audit**: confirm reuse terms per source (ATO/data.gov.au CC-BY,
      AEC use statement, AusTender, APH register PDFs). Record in the same
      `source_licence` pattern used by `house_prices`.

## Phase 1 — Tax × Shorts (cheapest proof of concept)

Source: [ATO Corporate Tax Transparency](https://data.gov.au/data/dataset/corporate-transparency)
— annual XLSX, ~4,100 entities: name, ABN, total income, taxable income, tax payable.

- [ ] Collector `-mode tax` (new `influence-collector` service or extend an existing
      collector): ingest all 11 annual reports (2013-14 → 2023-24).
- [ ] Migration: `corporate_tax` table keyed by ABN + income_year; join view to ASX
      codes via the entity spine.
- [ ] RPC `GetCompanyTaxProfile` + "Tax paid" card on `/shorts/[code]` stock pages
      (income vs taxable income vs tax payable, multi-year sparkline).
- [ ] Editorial feature: **"The $0 Tax Club"** — heavily-shorted companies paying no
      tax (widow-maker-style `/features/*` page, baked + live hybrid).
- [ ] Newsroom: expose tax profile as a grounded evidence source for take-writer.

## Phase 2 — Political donations (time-sensitive: new disclosure regime live 1 July 2026)

Source: [AEC Transparency Register bulk export](https://transparency.aec.gov.au/Download)
+ the [Electoral Reform Act 2025 scheme](https://www.aec.gov.au/FADReform/) —
donations >$5k now published within 10 days (24h during election periods).

- [ ] Collector `-mode donations`: ingest full historical bulk export (annual donor
      returns, party returns, associated entities) keyed by donor name/ABN.
- [ ] Poller for the new expedited-disclosure feed (10-day / 24h cadence) — this is
      the **first-mover product**: nobody has a live donations ticker yet because the
      data stream only just started.
- [ ] `/influence/donations` — live donations ticker + explorer (filter by donor,
      party, industry; reuse screener UI patterns).
- [ ] "Political donations" card on stock pages for ASX-listed donors.
- [ ] X bot: `donation-alert` command for large disclosures (dry-run default, per
      twitter-bot patterns).

## Phase 3 — Donations ↔ Contracts (the killer join)

Source: [AusTender contract notice export](https://data.gov.au/data/dataset/austender-contract-notice-export)
(weekly bulk + OCDS API to 2013; [historical to 1999](https://data.gov.au/data/dataset/historical-australian-government-contract-data))
+ [GrantConnect](https://www.grants.gov.au/) grants.

- [ ] Collector `-mode tenders`: weekly AusTender ingest (supplier ABN, agency,
      value, category, dates). Note: contract value = total life-of-contract max,
      not annual spend — label accordingly.
- [ ] Collector `-mode grants`: GrantConnect ingest.
- [ ] Join: donor ↔ supplier by ABN. Flagship editorial: **"Donate, then win"** —
      donations vs contract awards scatter/timeline per company. Facts + dates only
      (see editorial standards).
- [ ] "Government contracts" card on stock pages (contracts won, total value,
      agencies).
- [ ] Conflicts screener: extend `/screener` with influence filters (donated > $X,
      contracts > $Y, tax paid = 0, short interest > Z%).

## Phase 4 — Parliament's Portfolio (MP interests × ASX)

Source: [Register of Members'](https://www.aph.gov.au/senators_and_members/members/register)
/ Senators' Interests — PDFs; parse primary sources ourselves (do NOT lift data from
openpolitics.au / politiciantrades.au). Reuse the Appendix-3Y Gemini PDF-extraction
pipeline (`services/report-extractor/`).

- [ ] Extractor: interests-register PDFs → structured holdings (member, category,
      entity, date declared/altered). NOTE: registers disclose *what* is held, never
      quantity/value — a literal Pelosi-return index is impossible; design around it.
- [ ] Entity-match declared holdings to ASX codes / managed funds.
- [ ] `/parliament` explorer: parliament's most-held ASX stocks, per-MP profiles,
      per-party sector exposure.
- [ ] "Held by MPs" card on stock pages; event feed for register alterations
      ("MP added/removed X") — joinable to policy announcements + price/short moves.
- [ ] Editorial feature: **"Who Owns Parliament"**.

## Phase 5 — The influence graph + wider shadow datasets

- [ ] Fold donations/contracts/tax/MP-holdings into the existing entity/edge
      knowledge graph (Connections card) — `donated_to`, `won_contract_from`,
      `held_by_mp`, `lobbies_for` edges.
- [ ] **Lobbyist registers** (federal + state, downloadable): firm ↔ client links
      into the graph.
- [ ] **Ministerial diaries** (NSW + QLD publish; federal doesn't): "who met the
      minister" × donor × tender-winner chain.
- [ ] **Regulatory heat**: NACC / state ICAC outcomes, ACCC enforcement, ASIC
      banned/disqualified registers, Federal Court judgments → extend the existing
      Risk Signals card with primary-source integrity data.
- [ ] **Revolving door** (curated, human-in-the-loop): minister/staffer → industry
      moves. No official register exists — genuinely novel; newsroom editorial
      product, not a pipeline.
- [ ] **Resources & ownership registers**: foreign ownership of agricultural land
      & water (ATO), state mining tenements — Adani-style stories.
- [ ] **Political ads**: Meta Ad Library + Google political-ads transparency for AU.

---

# Track B — Financial Perspective (bear vs bull, fundamentals, macro, calculators)

> Parallel track to the Influence layer: help users *orient* financially. Ordered
> by value-per-effort; B1/B2 are pure recombination of data Shorted already stores.

## Phase B1 — Squeeze Radar + Battleground Stocks (recombine existing data) ⟵ START HERE

All inputs already exist: short % history (`shorts`), days-to-cover
(`mv_screener_data`, migration 000028), price momentum (`stock_prices`),
director trades, news sentiment.

- [x] **Squeeze-risk score**: days-to-cover × short-interest change × price
      momentum → 0-100 score. Computed in a new MV (follow `mv_screener_data`
      pattern + fallback raw query).
- [x] **Battleground detector**: price rising while shorts building (divergence).
      Rank by divergence magnitude; track resolution over time.
- [x] RPC `GetSqueezeCandidates` / extend `ScreenStocks` with squeeze + divergence
      filters.
- [x] `/battlegrounds` surface (or dashboard widget + screener filters) ranking
      live bull-vs-bear conflicts; squeeze-risk badge on stock pages.
- [ ] Alerts: squeeze-risk threshold crossings (Pro-tier email/X bot hook).

## Phase B2 — Bear/Bull verdict + short-seller scoreboard

- [x] **Verdict gauge** per stock: composite of short-interest trend, director
      buying/selling, news sentiment, squeeze risk — one glanceable dial.
- [x] **Short seller scoreboard**: historical outcomes of crowded shorts — when
      short interest peaked, what did price do next? Win-rate by stock/sector.
      Evergreen editorial + novel dataset (nobody computes ASX short-campaign
      outcomes).
- [ ] Editorial: "The shorts were right about X, wrong about Y" recurring format.

## Phase B3 — Banks × Housing flagship (APRA)

Source: APRA monthly ADI statistics (free XLSX) — per-bank loan books.

- [ ] Collector `-mode apra`: monthly ADI stats ingest (mortgage book size/growth
      per bank).
- [ ] Join: bank mortgage exposure × bank short positions × `house_prices` —
      the live, data-backed extension of the widow-maker thesis.
- [ ] Editorial feature + permanent `/housing` ↔ bank-stocks cross-links.

## Phase B4 — FY fundamentals + results-season engine

Reuses the Gemini PDF-extraction pipeline (`services/report-extractor/`) and
`asx_announcements`.

- [ ] Extract structured fundamentals from annual/half-year report PDFs: revenue,
      NPAT, EPS, dividend, net debt → `stock_fundamentals` table (multi-year).
- [ ] FY report card on stock pages (multi-year sparklines, joins existing
      `GetStockFinancialHighlights` digests).
- [ ] **Results calendar** + "most-shorted into earnings" watchlist.
- [ ] **"Did the shorts win?"** post-results scorecards — recurring content for
      newsroom + X bot every Feb/Aug reporting season.

## Phase B5 — Sector & macro spine

- [ ] Sector rotation dashboard: short interest aggregated by industry over time
      (add time dimension to treemap MV) + commodity overlays (RBA commodity
      index CSV — iron ore vs materials shorts, oil vs energy).
- [ ] Macro ingest: RBA cash rate, ABS CPI/unemployment, AUD, yield curve →
      `/macro` page + **context bands on existing charts** ("shorts spiked as
      CPI printed 7.8%").
- [ ] ASIC insolvency statistics: company failures by industry as a distress
      indicator joined to sector shorts.

## Phase B6 — Housing calculators (fed by live suburb data)

Differentiator vs bank calculators: pre-filled from `house_prices` +
`suburb_demographics`, deep-linked from suburb profile pages.

- [ ] **Mortgage simulator**: extra repayments, offset balance, lump sums,
      rate-shock slider (generalise the widow-maker borrowing-power @visx
      pattern).
- [ ] **"Years to a deposit" choropleth**: time to save 20% deposit on median
      household income per suburb (both inputs already in DB) — new
      `highlight-metrics.ts` entry (recipe G).
- [ ] Rent-vs-buy + stamp-duty-by-state calculators (baked state rule tables).
- [ ] SEO surfaces per calculator (broad first-home-buyer audience).

## Phase B7 — Policy tagging + crowd sentiment

- [ ] **Policy tagging layer** on the news aggregator: classify articles by policy
      area (housing schemes, energy, infrastructure, defence) → link to affected
      sectors/stocks/suburbs; "Policy impact" feeds on /housing, sector, stock
      pages. (News-side rendering of the influence graph — ties to Track A.)
- [ ] **The crowd vs the shorts**: signed-in bull/bear votes per stock, scored
      against outcomes, leaderboard. Aggregate crowd-vs-short-interest spread
      becomes a proprietary dataset.

---

## Cross-cutting

- [ ] Unify branding: `/influence` landing surface tying shorts + housing +
      influence into the "shadow data" identity (masthead treatment like housing).
- [ ] Terraform Cloud Run job(s) for the new collector modes (follow
      house-price-collector module pattern; scheduler in australia-southeast1).
- [ ] MVs for hot queries (donor totals, contract totals, tax-by-code) with
      fallback raw queries, per existing MV pattern.
- [ ] SEO/LLM surfaces: sitemaps, OG images, llms.txt entries for new routes.

## Key constraints & landmines

- **Defamation**: facts + citations, no imputation (Phase 0 doc gates all editorial).
- **MP interests have no values/quantities** — never imply portfolio size/returns.
- **AusTender values are life-of-contract**, not annual expenditure.
- **Don't scrape civic-tech aggregators** — always primary sources (APH, AEC, ATO).
- **AEC scheme transition**: pre/post-1-July-2026 data have different thresholds
  ($16.9k → $5k) — normalise carefully or comparisons mislead.
