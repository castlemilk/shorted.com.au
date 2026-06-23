# The Widow-Maker — Australian housing feature (design)

**Date:** 2026-06-23
**Route:** `/features/the-widow-maker` (new top-level `/features` section)
**Type:** Bespoke, scroll-driven editorial feature with 4 interactive dashboards.
**Spine (Shorted-native):** You can't short a house, so bears short the big-four banks — and it's been a graveyard ("the widow-maker"). The feature dissects the machine that keeps Australian prices up (negative gearing → 1999 CGT discount → bank credit), then shows what Japan/China/US corrections reveal about when it jams.

## Goals
- A flagship, award-quality interactive feature in the Shorted house aesthetic (amber/terminal + `Newsreader` serif).
- Every number verified & sourced (research dossier 2026-06-23, 41 sources). Estimates/derived figures flagged in-caption.
- Three new curated-data dashboards + one live ASIC dashboard, all built on existing `visx` primitives.
- Full SEO: Article JSON-LD, route OG image, `LLMMeta`, canonical, sitemap entry.

## Editorial structure (~2,500 words, house voice)
- **Hero** — "The Widow-Maker". Stat strip: record ~A$11bn big-four short (Jun 2026); CBA −10.4% on 13 May 2026 (worst day in 34yrs, ~A$25bn wiped); CBA A$5.40→~A$192 since 1991.
- **I. The trade that bankrupts the brave** — Tepper & Hempton Feb-2016 undercover Sydney field trip; "30–50% fall" call; why it bled (franked dividends shorts pay; ~A$7bn buybacks). Corrects Eisman=Canada myth. → **① Bank short basket (live)**
- **II. The first prop — negative gearing** — 1.12m negatively-geared landlords, ~A$10.4bn losses (2022-23); 1985–87 experiment.
- **III. The accelerant — the 1999 CGT discount** — RBA's "leverage amplifier" quote; investor-share surge. → **② Policy vs prices**
- **IV. The engine — bank buying power** — credit channel (RBA RDP 2019-01: −1pp real rate → +28% prices long-run); ~A$1.9tn big-four book; debt-to-income ~187% peak; APRA macroprudential. → **③ Buying power & debt**
- **V. What breaking looks like — Japan, China, America** → **④ International corrections**
- **VI. The reckoning** — does the short finally work? May-2026 crack; bear case; mean-reversion anchor.
- **Sources & method** — full bibliography, per-chart data notes, disclaimer, CTA into bank stocks.

## Dashboards (verified data)
1. **Bank short basket** — reuse live `ShortBasketChart`/`BankShortBasket` (`web/src/@/components/news/mdx/`). Re-bake series. Caption with A$11bn/−10.4%.
2. **Policy vs prices** (new visx dual-axis) — real HPI (1980→2025, OECD `AUS.A.RHP.IX` 2015=100) + investor share of new lending (ABS Lending Indicators); annotation markers 1985–87 NG quarantine + 1999 CGT discount; optional overlay = negatively-geared landlord count (ATO).
3. **Buying power & debt** (new) — household debt-to-income (RBA E2, 1990→2025, 187% peak flag) + OECD price-to-income index; APRA macroprudential markers (2014 investor cap, 2017 IO cap, 2021 buffer); interactive **borrowing-power slider** (drag mortgage rate → implied price move via RBA −1pp→+28% elasticity). Headline: combined big-four book ≈A$1.9tn (DERIVED = ~77% × A$2,475bn APRA system book, Dec 2025).
4. **International corrections** (new multi-line) — real HPI Australia/Japan/USA/China, peak-normalised on years-from-peak x-axis (calendar toggle); crash annotations Japan −49% (peak Q1 1991), US −27% (Jul 2006), China −23% & falling (Sep 2021), Australia no crash (~−5% off 2021 peak). BIS via FRED + Case-Shiller.

## Architecture / files
- `web/src/app/features/the-widow-maker/page.tsx` — server component: metadata, Article JSON-LD, `LLMMeta`, renders sections; charts via `dynamic({ssr:false})`.
- `web/src/app/features/the-widow-maker/opengraph-image.tsx` — route OG image (amber/title).
- `web/src/@/components/features/housing/` — bespoke editorial + chart components:
  - editorial: `hero.tsx`, `stat-strip.tsx`, `section.tsx`, `pull-quote.tsx`, `cite.tsx`, `sources-list.tsx`, `scroll-reveal.tsx`, `feature-chart-frame.tsx`
  - charts: `policy-price-chart.tsx`, `buying-power-chart.tsx`, `borrowing-power-slider.tsx`, `international-corrections-chart.tsx`
  - `data/` — `types.ts`, `policy-prices.ts`, `buying-power.ts`, `international.ts`, `sources.ts`, `narrative-stats.ts` (typed, each value carries a source id)
- Sitemap: add `/features/the-widow-maker`.

## Look & tech
Amber/terminal palette via CSS vars (`hsl(var(--primary))` etc.); `Newsreader` serif (`font-serif`) display headings; IBM Plex Mono for data/labels; dark-mode-native cinematic hero; drop caps, pull-quotes (5 sourced), stat callouts; scroll-reveal via `react-spring`/CSS, `prefers-reduced-motion` respected; inline superscript `<Cite>` linking to bibliography. Charts on `@visx/*` (scale/shape/axis/tooltip/responsive), no recharts/framer-motion.

## Data integrity rules
- Transcribe only verified dossier values. Mark DERIVED/estimate/anchor figures in-caption.
- Bank basket = live ASIC (no curation).
- Cross-country chart = peak=100 normalisation only (different bases) — the honest overlay.

## Verification
- `cd web && npx tsc --noEmit` + eslint.
- Run dev (port 3020); confirm LISTEN pid is mine; Playwright screenshots light/dark/mobile; stop server after.

## Out of scope (now)
- Nav linking / publishing the page publicly (build live, review locally first).
- New backend endpoints (live basket already exists; macro data is curated).
