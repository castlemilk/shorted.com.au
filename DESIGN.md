---
name: Shorted
description: ASIC short-selling intelligence for the ASX, built as a warm CRT terminal.
colors:
  burnt-amber: "#9E5210"
  phosphor-amber: "#FFAC4D"
  clay-rust: "#D06D49"
  tawny-rust: "#E17E51"
  avocado: "#87A86B"
  sage: "#9AC082"
  warm-paper: "#F9F8F5"
  paper-card: "#FDFDFC"
  chocolate-ink: "#483932"
  muted-paper: "#F2F0ED"
  muted-ink: "#72625A"
  paper-border: "#E5E1DC"
  crt-black: "#0D0D0D"
  lifted-black: "#121212"
  warm-sand: "#E8DEB5"
  dimmed-sand: "#A39A75"
  terminal-border: "#352E27"
  signal-red: "#EF4444"
  signal-green: "#22C55E"
  signal-red-dark: "#F87171"
  signal-green-dark: "#4ADE80"
typography:
  display:
    fontFamily: "Newsreader, Georgia, serif"
    fontSize: "1.875rem"
    fontWeight: 700
    lineHeight: 1.1
    letterSpacing: "-0.025em"
  headline:
    fontFamily: "Newsreader, Georgia, serif"
    fontSize: "1.5rem"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "-0.025em"
  title:
    fontFamily: "IBM Plex Mono, ui-monospace, monospace"
    fontSize: "1.125rem"
    fontWeight: 600
    lineHeight: 1
    letterSpacing: "-0.025em"
  body:
    fontFamily: "IBM Plex Mono, ui-monospace, monospace"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "normal"
  label:
    fontFamily: "IBM Plex Mono, ui-monospace, monospace"
    fontSize: "0.75rem"
    fontWeight: 400
    lineHeight: 1
    letterSpacing: "0.16em"
rounded:
  sm: "2px"
  md: "4px"
  lg: "6px"
spacing:
  xs: "6px"
  sm: "8px"
  md: "12px"
  lg: "24px"
components:
  button-primary:
    backgroundColor: "{colors.burnt-amber}"
    textColor: "{colors.warm-paper}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "8px 16px"
    height: "40px"
  button-primary-hover:
    backgroundColor: "{colors.burnt-amber}"
    textColor: "{colors.warm-paper}"
  button-outline:
    backgroundColor: "{colors.warm-paper}"
    textColor: "{colors.chocolate-ink}"
    rounded: "{rounded.md}"
    padding: "8px 16px"
    height: "40px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.chocolate-ink}"
    rounded: "{rounded.md}"
    padding: "8px 16px"
    height: "40px"
  card:
    backgroundColor: "{colors.paper-card}"
    textColor: "{colors.chocolate-ink}"
    rounded: "{rounded.lg}"
    padding: "{spacing.lg}"
  input:
    backgroundColor: "{colors.warm-paper}"
    textColor: "{colors.chocolate-ink}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "8px 12px"
    height: "40px"
  eyebrow:
    textColor: "{colors.muted-ink}"
    typography: "{typography.label}"
---

# Design System: Shorted

## 1. Overview

**Creative North Star: "The Melbourne Terminal"**

Shorted is institutional-grade market instrumentation that grew up somewhere warm. It takes the density, precision and numeric discipline of a trading terminal, then refuses the coldness that usually comes with it: no navy, no steel, no glass. Every neutral is tinted toward amber, the default typeface across the entire application is a monospace, and the two themes read as two rooms rather than two palettes. Light mode is a daylight desk, warm paper under a window. Dark mode is the same desk after hours, lit only by the phosphor of the screen.

The system is monospace-first in a way that is unusual and load-bearing. IBM Plex Mono is not the code face here, it is the *app* face: chrome, labels, tables, buttons, navigation and every numeral. That single decision does most of the identity work. Newsreader serif appears only where the product stops being an instrument and starts being a publication, on page titles, standalone section headlines and the editorial surfaces at `/news` and `/features`. The boundary between those two faces is the boundary between reading and operating, and it is never blurred for decoration.

Data provenance is a visual obligation, not a footnote. ASIC sourcing, T+4 disclosure lag, as-at dates and methodology links are part of the composition. The voice is factual, precise and lightly wry, never hypey. What this system explicitly rejects, carried from PRODUCT.md: purple-blue gradients, gradient text, glassmorphism-by-default, and identical icon-card grids. If a screen could belong to any generic fintech SaaS product, it has failed.

**Key Characteristics:**
- Monospace-first: IBM Plex Mono is the application default, not an accent
- Warm-tinted neutrals; no pure `#000` or `#fff` anywhere in the system
- Two rooms, not two palettes: warm paper by day, CRT black after hours
- Numbers are first-class: `tabular-nums`, right-aligned, compact AUD formatting
- Flat surfaces at rest; amber light is a response, never a texture
- Provenance visible: source, lag and methodology travel with the data

## 2. Colors

A single warm hue family carries the entire system, with olive and rust as supporting voices and true red/green reserved exclusively for market semantics.

### Primary
- **Burnt Amber** (`--primary` light / `--ring` light, `hsl(28 82% 34%)`): The light-mode primary. Deliberately darkened well past the brand amber so it clears WCAG AA as body-weight text and as link colour on warm paper. Used for links, active controls, filled buttons, the accent eyebrow, and the light-mode focus ring (5.40:1 on warm paper).
- **Phosphor Amber** (`--primary` dark / `--ring` dark / `--glow-color`, `hsl(32 100% 65%)`): The same hue as emitted light rather than pigment. Dark-mode primary, the dark-mode focus ring (10.42:1 on CRT black), the chart line stroke, and the source colour for every glow in the elevation system.

**The Two Rooms Rule.** The primary is theme-split by lightness, never by hue. Burnt Amber is ink on paper; Phosphor Amber is light from a screen. Never use the dark-mode amber as text on a light background, and never dim the light-mode amber to fake a glow. **`--ring` is split the same way and for the same reason**: Phosphor Amber on warm paper measures 1.76:1, so a light-mode focus ring drawn in it is invisible to a keyboard user. WCAG 2.4.11 and 1.4.11 require 3:1.

### Secondary
- **Avocado** (`--secondary` light, `hsl(93 26% 54%)`) and **Sage** (`--secondary` dark, `hsl(96 33% 63%)`): Muted olive for secondary actions, toggles and non-urgent state. Present enough to be a second voice, desaturated enough never to compete with amber.

### Tertiary
- **Clay Rust** (`--accent` light, `hsl(16 59% 55%)`) and **Tawny** (`--accent` dark, `hsl(19 71% 60%)`): Warm alert register for important labels and emphasis. Sits between amber and the destructive red without belonging to either.

### Neutral
- **Warm Paper** (`--background` light, `hsl(40 25% 97%)`): The daylight surface. Warm white, never `#fff`.
- **Paper Card** (`--card` light, `hsl(40 20% 99%)`): Cards lift *toward* white rather than casting a shadow.
- **Chocolate Ink** (`--foreground` light, `hsl(19 18% 24%)`): Body text. Brown-black, never neutral black.
- **Muted Ink** (`--muted-foreground` light, `hsl(19 12% 40%)`): Secondary text, held at AA against warm paper.
- **CRT Black** (`--background` dark, `hsl(0 0% 5%)`) and **Lifted Black** (`--card` dark, `hsl(0 0% 7%)`): The after-hours room. Cards separate by a two-point lightness lift, not a shadow.
- **Warm Sand** (`--foreground` dark, `hsl(48 52% 81%)`) and **Dimmed Sand** (`hsl(48 20% 55%)`): Dark-mode text. The warmth of the paper theme survives the inversion.
- **Paper Border** (`hsl(32 15% 88%)`) and **Terminal Border** (`hsl(32 15% 18%)`): Hairline separators, both tinted to the amber hue.

### Semantic
- **Signal Red / Signal Green** (`#EF4444` / `#22C55E` light, `#F87171` / `#4ADE80` dark): True red and green, quarantined for market direction, min/max markers and price movement. Chart series use the warm palette instead: rust `#D16A47`, avocado `#87A96B`, amber stroke `#FFA94D`.

**The Semantic Quarantine Rule.** True red and green mean *direction of a number* and nothing else. Never use them for brand accent, decoration, generic success/error styling, or any surface that isn't reporting a market movement. Everything else warms to rust or olive.

## 3. Typography

**Display Font:** Newsreader (variable 200–800, with Georgia fallback)
**Body / Label / Mono Font:** IBM Plex Mono (with `ui-monospace` fallback)

**Character:** A monospace that reads as an instrument, paired with a serif that reads as a masthead. The tension between them is the product: measurement on one side, journalism on the other. Because the mono is the *default* rather than the exception, serif arrives with real weight when it appears.

### Hierarchy
- **Display** (Newsreader, 700, `text-3xl` → `sm:text-4xl`, `tracking-tight`, `text-balance`): The single page `h1`. Canonical token `pageTitle` in `web/src/@/lib/typography.ts`.
- **Headline** (Newsreader, 600, `text-2xl`, `tracking-tight`): A standalone major section `h2` with whitespace around it. Token `sectionTitle`. Not for dense in-card sub-labels.
- **Title** (IBM Plex Mono, 600, `text-lg`, `leading-none`, `tracking-tight`): Card and widget headers via shadcn `<CardTitle>`, typically with an inline `h-5 w-5` lucide icon. Deliberately *not* a typography token, so it can't drift from the component.
- **Body** (IBM Plex Mono, 400, `text-sm` in chrome, `text-base` in prose, `line-height: 1.5`): Default reading text. Cap editorial measure at 65–75ch; the `lede` token fixes this at `max-w-2xl`.
- **Label** (IBM Plex Mono, 400, `text-xs`, uppercase, `tracking-[0.16em]`): The eyebrow/kicker above a headline or card group. Token `eyebrow`, muted by default; compose `cn(eyebrow, "text-primary font-medium")` for the accent variant.

**The One Type System Rule.** Never hand-roll a heading class stack. Import `pageTitle`, `sectionTitle`, `eyebrow` or `lede` from `web/src/@/lib/typography.ts`, or use `<CardTitle>`. Equivalent heading levels drifting in weight, size or tracking is the exact failure these tokens exist to prevent.

**The Serif Boundary Rule.** Serif is permitted on page titles (`h1`), standalone section headlines (`h2`), and editorial display heroes (`/news`, `/features`, the housing tracker). Serif is forbidden on card titles, dashboard and widget labels, control bars, table headers, buttons, navigation, and every numeral. If it is chrome or a number, it is mono. The `/shorts/[stockCode]` stock header stays mono by design.

**The Tabular Rule.** Every numeral is `tabular-nums` and right-aligned in tables. Currency uses compact AUD ($1.2B / $340M / 11.62%). Columns of numbers must align on the decimal without exception.

## 4. Elevation

The system is **flat at rest**. Depth comes from tonal layering and hairline warm borders, not from drop shadows: in light mode cards lift toward white (`#FDFDFC` on `#F9F8F5`), in dark mode they lift two points off black (`#121212` on `#0D0D0D`). Conventional grey drop shadows are absent by design; the only shadow vocabulary in the system is *amber light*, and it is a response to state rather than a property of a surface.

### Shadow Vocabulary
- **`amber-sm`** (`0 0 10px -3px hsl(32 100% 65% / 0.3)`): Subtle hover lift on compact controls.
- **`amber`** (`0 0 20px -5px hsl(32 100% 65% / 0.4)`): Standard hover/active emphasis.
- **`amber-lg`** (`0 0 30px -5px hsl(32 100% 65% / 0.5)`): Reserved for a single hero moment per view.
- **`amber-glow`** (`0 0 0 1px hsl(32 100% 65% / 0.2), 0 0 30px -5px hsl(32 100% 65% / 0.4)`): Ring-plus-bloom for focus and selected state.
- **`terminal-inset`** (`inset 0 0 20px -10px hsl(32 100% 65% / 0.2)`): Inner phosphor bloom for terminal-style panels.
- **`.text-glow` / `.box-glow`**: Utility glows that intensify in dark mode (text picks up a third 24px halo; box gains an inset bloom).

### CRT Atmosphere
`.scanlines` overlays a 4px repeating gradient at `--scanline-opacity` (0.03 light, 0.05 dark). `phosphor-in` fades content in from `--phosphor-blur` (0px light, 1px dark). These are the system's signature texture and its most abusable feature.

**The Flat-By-Default Rule.** Surfaces are flat at rest. Amber light appears only as a response to state: hover, focus, active, or a data condition that demands attention. A glow that is always on is decoration, and decoration is prohibited.

**The One Bloom Rule.** At most one `amber-lg` or `box-glow` element per view, and scanlines only on genuine terminal surfaces. If two things glow at once, neither reads as signal. Audit test: screenshot the view, squint, and count the bright spots. More than one means the hierarchy has failed.

## 5. Components

Components are **precise instruments, not decoration**. Chrome recedes so data leads: mono labels, tabular numerals, tight 6px radii, hairline warm borders, no ornament. If a component draws attention to itself rather than to its value, it is wrong.

### Buttons
- **Shape:** Tight, near-square corners (4px, `rounded-md`), 40px default height (`h-10 px-4 py-2`).
- **Primary:** Burnt Amber fill with warm-paper text; hover drops to 90% opacity.
- **Secondary:** Avocado fill, hover to 80%. For non-urgent parallel actions.
- **Outline / Ghost / Link:** Outline uses a warm 1px border on background; ghost is transparent until hover tints to accent; link is Burnt Amber with `underline-offset-4`.
- **Focus:** `focus-visible:ring-2 ring-ring ring-offset-2` — Burnt Amber on paper, Phosphor Amber on CRT black. Never remove it.
- **Sizes:** `sm` 36px, default 40px, `lg` 44px, `icon` 40×40. `sm` is the working size of the terminal — toolbars, segmented period selectors, table row actions, widget chrome — and it is *deliberately* below the 40px primary size. It is not raised to meet it: collapsing `sm` into `default` would cost the density the product exists for, and would not reach the call sites that already override the height downward anyway.

**The Two Floors Rule.** Target sizes answer two different questions, and one number cannot serve both. **24px is the floor**, and it is not negotiable: WCAG 2.5.8 (AA) requires 24×24 CSS px for every pointer target, dense chrome included. **40px is the aim** for anything a phone user reaches for first — primary actions, navigation, the control a task starts with. Between the two sits the working chrome, where a 36px `sm` button or a 24px inline row action is correct rather than compromised. When a control has to stay small, grow the *target* and not the control: `.hit-target` (≥24px) and `.hit-target-touch` (≥40px) in `globals.css` expand the hit box with a transparent, centred pseudo-element and leave layout, rhythm and drawn size untouched. Never let one of those invisible targets reach a neighbouring control — a tap that lands on the wrong thing is worse than a tap that misses.

### Cards / Containers
- **Corner Style:** 6px (`rounded-lg`), the softest radius in the system.
- **Background:** Paper Card on warm paper; Lifted Black on CRT black.
- **Border:** 1px warm hairline, always present. The border does the separating, not a shadow.
- **Shadow Strategy:** Flat at rest (see Elevation). Glow only on state.
- **Internal Padding:** 24px (`p-6`); header stack `space-y-1.5`, content and footer `p-6 pt-0`.
- **Data card grammar:** `CardHeader pb-3` + `CardTitle text-lg` with an inline `h-5 w-5` lucide icon + `CardDescription` count line. This is the default and should cover most surfaces.
- **Hero card:** Gradient header with icon-in-tinted-box. Maximum one to two per view.

### Inputs / Fields
- **Style:** 40px tall, 1px warm border, background surface, 4px radius, 12px horizontal padding, mono text at `text-sm`.
- **Boundary:** `--input` (`hsl(32 20% 50%)` light, `hsl(32 20% 40%)` dark) is the *control boundary* token and is deliberately heavier than the decorative `--border` hairline. A field's edge is the only thing identifying it as a control, so it holds 3:1 against the background in both rooms (3.47:1 / 3.62:1) per WCAG 1.4.11. Do not soften it toward `--border`, and do not use it as a fill.
- **Focus:** Theme-split amber ring with 2px offset (see Colors). The focus ring is the glow.
- **Placeholder:** Muted Ink. **Disabled:** `cursor-not-allowed` at 50% opacity.

### Navigation
Mono throughout, at label or body scale. Active state carries Burnt Amber; hover tints toward accent. Navigation never uses serif.

### Charts (Signature)
A shared `@visx` core across the product. Series use the **warm** palette (rust `#D16A47`, avocado `#87A96B`, amber stroke `#FFA94D`); direction indicators use the quarantined semantic red/green. Axis and label text is mono with `tabular-nums`. Housing and terminal surfaces lead with the amber series.

**The Chrome Recedes Rule.** Borders are 1px. Radii are 6px or less. Icons are 16–20px. If chrome competes with a number for attention, the number loses, and that is a bug.

## 6. Do's and Don'ts

### Do:
- **Do** tint every neutral toward the amber hue. Warm Paper (`hsl(40 25% 97%)`) and CRT Black (`hsl(0 0% 5%)`), never `#fff` or `#000`.
- **Do** import type tokens from `web/src/@/lib/typography.ts` (`pageTitle`, `sectionTitle`, `eyebrow`, `lede`) instead of hand-rolling class stacks.
- **Do** keep every numeral mono and `tabular-nums`, right-aligned in tables, with compact AUD formatting.
- **Do** reserve true red and green for market direction only.
- **Do** keep surfaces flat at rest and let amber glow respond to state.
- **Do** ship data provenance with the data: ASIC source, T+4 lag, as-at dates, methodology and disclaimer links. "Not financial advice" is load-bearing.
- **Do** treat SEO as a design constraint on public pages: crawlable facts, JSON-LD, stable slugs and heading order.
- **Do** hold WCAG AA contrast, a 24px hit-area floor with 40px on primary and mobile-first targets (see The Two Floors Rule), keyboard reachability, and honour `prefers-reduced-motion` for any non-trivial animation.

### Don't:
- **Don't** use purple-blue gradients, gradient text (`background-clip: text`), glassmorphism-by-default, or identical icon-card grids. These are the named anti-references from PRODUCT.md and they are prohibited outright.
- **Don't** put serif on card titles, dashboard or widget labels, control bars, table headers, buttons, navigation, or numerals. Chrome is mono, always.
- **Don't** use `border-left` or `border-right` greater than 1px as a coloured accent stripe. The one sanctioned exception is the existing hero-card `border-l-4`, capped at one to two per view; do not spread the pattern to standard cards, list items, callouts or alerts.
- **Don't** leave a glow switched on at rest, stack multiple `amber-lg` blooms in one view, or apply scanlines to non-terminal surfaces.
- **Don't** use the dark-mode Phosphor Amber as text on light backgrounds. It fails AA. Burnt Amber exists precisely for that job.
- **Don't** introduce a conventional grey drop shadow. This system has no drop-shadow vocabulary; depth is tonal.
- **Don't** reach for `--font-display`. Space Grotesk was removed in 2026-07 with zero usages and the CSS variable in `globals.css` is now dead; it silently falls back to system sans. Use mono or the serif tokens.
- **Don't** reach for a modal as the first answer, or wrap content in nested cards. Exhaust inline and progressive disclosure first.
- **Don't** write em dashes in UI copy. Use commas, colons, semicolons, periods or parentheses.
