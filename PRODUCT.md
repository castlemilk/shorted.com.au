# Design Context — Shorted.com.au

<!-- Written by Claude 2026-07-09 from the established codebase design system +
     product docs. Owner: please correct anything that misstates intent. -->

## Product
Shorted tracks ASIC short-selling positions for ASX stocks: daily short
interest, price overlays, screeners, news/sentiment, director trades,
AI-enriched company research, and editorial investigations.

## Target audience
- Australian retail investors and finance-curious readers checking "how
  shorted is this stock?" (majority; often landing from search on a
  per-stock page).
- Power users: active traders, finance professionals, and quants using the
  screener, API, and dashboards.
- Journalists/researchers using the editorial features and data stories.

## Use cases (jobs to be done)
- Look up a stock's current short interest + trend in seconds.
- Compare a stock against industry peers; scan for squeeze setups.
- Monitor news, director trades, dividends, and risk signals around a
  position.
- Deep research: AI-enriched company profiles, financial reports, community
  discussion.

## Brand personality / tone
"Amber Terminal Glow" — a warm, CRT-terminal-inspired data product. Feels
like a Bloomberg terminal that grew up in Melbourne: monospace-first
(IBM Plex Mono as the app-wide sans), warm paper light mode, near-black CRT
dark mode with glowing amber primary (#FFA94D range). Serious about data
provenance (ASIC-sourced, T+4 disclaimers everywhere), playful only at the
edges. Editorial surfaces (/news, features) get Newsreader serif; app
chrome stays terminal.

- Voice: factual, precise, lightly wry. Never hypey. "Not financial advice"
  is a load-bearing phrase.
- Numbers are first-class: tabular-nums, right-aligned, compact AUD
  formatting ($1.2B / $340M / 11.62%).

## Design system facts (do not fight these)
- Tokens: HSL CSS vars in `web/src/styles/globals.css` consumed via
  Tailwind (`hsl(var(--x))`). Radius scale off `--radius` (0.375rem);
  cards use `rounded-lg`.
- Dark mode: class strategy via next-themes. Off-token colors are
  hand-paired light/dark utilities (e.g. `text-emerald-600
  dark:text-emerald-400`).
- Card grammar: standard data card = `CardHeader pb-3` + `CardTitle
  text-lg` with inline `h-5 w-5` lucide icon + `CardDescription` count
  line. Hero card (max 1-2 per view) = `border-l-4` accent stripe +
  gradient header + icon-in-tinted-box.
- shadcn/Radix primitives from `web/src/@/components/ui/` (a second
  registry copy exists at `@/registry/new-york/ui` — Avatar/Tooltip live
  there).
- Charts: shared `@visx` StockChart core; semantic up/down =
  emerald/red pairs; amber series for housing/terminal surfaces.
- Accessibility floor: WCAG AA contrast; hit areas at or above the WCAG
  2.5.8 (AA) 24px minimum, rising to 40px for primary actions and anything
  a phone user reaches for first (nav, first-touch controls) — dense
  terminal chrome deliberately sits between the two, see "The Two Floors
  Rule" in DESIGN.md; keyboard-reachable interactive elements;
  `prefers-reduced-motion` honored for any non-trivial animation.

## Non-negotiables
- Data provenance framing stays (ASIC source, T+4 delay, methodology and
  disclaimer links).
- SEO is a first-class constraint on public pages: crawlable facts, JSON-LD,
  stable slugs and headings.
- No AI-slop tells: no purple-blue gradients, no gradient text, no
  glassmorphism-by-default, no identical icon-card grids.

## Typography system

Canonical tokens live in `web/src/@/lib/typography.ts`. **Never hand-roll these
class stacks** — import the token so equivalent heading levels can't drift in
weight, size, or tracking. Four display tiers plus the mono chrome default:

- **`eyebrow`** — `font-mono text-xs uppercase tracking-[0.16em]
  text-muted-foreground`. The small uppercase kicker above a headline or card
  group. Compose the accent variant with `cn(eyebrow, "text-primary
  font-medium")`.
- **`pageTitle`** — `font-serif text-3xl font-bold tracking-tight text-balance
  sm:text-4xl`. The single page `h1` (Newsreader serif display face).
- **`sectionTitle`** — `font-serif text-2xl font-semibold tracking-tight`. A
  standalone major section `h2` with whitespace around it.
- **`lede`** — `mt-2 max-w-2xl text-muted-foreground`. The muted intro
  paragraph directly under a page title. Centred hero variant: `cn(lede,
  "mx-auto text-lg")`.

Mono chrome tiers (the terminal default, IBM Plex Mono): shadcn `<CardTitle>`
owns the card-title level (do not duplicate it as a token); dashboard/widget
and control-bar labels, table headers, buttons, nav, tabs, and all numerals
stay mono `tabular-nums`.

**Serif is used** for the page `pageTitle` (h1) and standalone `sectionTitle`
(h2) on content/editorial pages, and for editorial display heroes (news,
`/features`, housing tracker) which keep their own larger bespoke scale.
**Serif is NOT used** for card titles, dashboard/widget/control-bar labels,
tables, buttons, nav, or any dense terminal chrome — those stay mono. The
`/shorts/[stockCode]` stock header stays mono by design. Marketing heroes
(`/about`) and the chat app-chrome are out of the token system.

Reference surface (the type system was distilled from it):
`app/industry-intelligence/industry-intelligence-client.tsx`.

## Industry Intelligence

- Audience: research-heavy retail investors, professional advisers, journalists, and developers evaluating ASX short-interest context.
- Brand read: evidence-led, sharp, restrained, and serious. The UI should feel like an investigative research terminal, not a generic fintech landing page.
- Visual system: keep the existing amber terminal and editorial theme. Use warm paper surfaces, CRT-dark panels, mono numerals, and restrained amber/rust accents.
- Product promise: compress complex market, industry, and public-source context into layered evidence that a user can inspect, save, and monitor.
- Content rules: cite primary sources, show as-at dates, avoid causal claims, and use neutral labels such as Policy Footprint, Public Money, and Trade Exposure.
- Conversion rule: Premium unlocks depth, alerts, and evidence packs. API Access unlocks bulk feeds and automation.
- Interaction rule: make the industry view link naturally to `/top`, `/stocks`, `/industry/[slug]`, and `/shorts/[stockCode]`.

