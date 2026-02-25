# Shorted.com.au — Design Brief

> Reference document for creating logos, assets, banners, social media graphics, and brand collateral.

---

## 1. Brand Overview

| | |
|---|---|
| **Name** | Shorted |
| **Domain** | shorted.com.au |
| **Tagline** | "Decode Market Sentiment" |
| **What it is** | Australian financial data platform tracking ASIC short selling positions on ASX stocks |
| **Audience** | Retail investors, financial professionals, market analysts — Australian market |
| **Tone** | Data-driven, precise, professional with a retro-futuristic edge |
| **Contact** | contact@shorted.com.au |

---

## 2. Logo & Mascot

### Current Logo
The logo features a **bear mascot** — a stylized, aggressive bear in profile view with:
- **Downward arrow** integrated into the composition (symbolizing short selling / bearish positions)
- **Flames** surrounding the bear (intensity, market heat, volatility)
- **Circular framing** — the bear and arrow sit within a rounded badge/emblem shape

### Logo Variants

| Variant | File | Description |
|---------|------|-------------|
| **Full color** | `logo.png` | Dark navy/steel blue bear, orange-red flames, red-orange downward arrow, dark circular frame |
| **Monochrome** | `logo-minimal.png` | Pure black silhouette on transparent — bear + flames + downward arrow |
| **Icon** | `icon-1.webp` | Square format, dark teal background, full-color bear emblem |

### Logo Color Breakdown
- **Bear body**: Dark steel blue / navy (`~#1a2744` to `#2d4a7a`)
- **Flames**: Gradient from deep orange (`#cc4400`) through bright orange (`#ff6600`) to amber tips (`#ffaa00`)
- **Arrow**: Orange-red gradient (`#cc3300` to `#ff4400`)
- **Bear eye**: Red accent dot
- **Outline/frame**: Dark charcoal with subtle warm undertone

### Mascot Guidelines
- The bear represents "bearish" market sentiment (short selling = betting prices will fall)
- Flames convey urgency, market heat, and the "burning" intensity of short interest data
- The downward arrow is the core symbol — short positions push prices down
- Style is bold and illustrative — esports/gaming-adjacent but appropriate for finance

---

## 3. Design Theme: "Amber Terminal Glow"

The entire UI is inspired by **1970s CRT amber phosphor monitors** — the warm orange glow of early computer terminals. This is not just dark mode, it's a deliberate aesthetic choice that runs through every element.

### Design Pillars
1. **Terminal First** — Monospace typography everywhere, data reads like a phosphor screen
2. **Warm, Not Stark** — Cream backgrounds (light), warm charcoal + sand text (dark). Never pure white or harsh black
3. **Amber Is The Brand** — The signature amber glow (`#FFA94D`) is the primary color, especially prominent in dark mode
4. **Data Density** — Compact labels, tight spacing, tabular numerics. Built for scanning financial data fast
5. **Subtle Animation** — Phosphor reveals, glow pulses, cursor blinks. All slow (2–4s), never distracting
6. **Glass + Blur** — Header and dropdowns use frosted glass (`backdrop-blur`) for layered depth within the retro aesthetic

---

## 4. Color Palette

### Primary Brand Colors

| Name | Hex | HSL | Usage |
|------|-----|-----|-------|
| **Amber** (Primary) | `#FFA94D` | `32 100% 65%` | Primary actions, brand color, glowing accents, chart lines, focus rings |
| **Terracotta** (Accent) | `#D16A47` / `#E07E50` | `16-19 59-71% 55-60%` | Secondary accent, alerts, "hot" data |
| **Avocado Green** (Secondary) | `#87A96B` / `#A0C080` | `93-96 26-33% 54-63%` | Positive indicators, secondary actions |
| **Terminal Black** | `#0C0C0C` | `0 0% 5%` | Dark mode background |
| **Warm Sand** | `#E8DDB5` | `48 52% 81%` | Dark mode body text |
| **Parchment** | `#F9F8F5` | `40 25% 97%` | Light mode background |
| **Chocolate** | `#4A3B34` | `19 18% 24%` | Light mode body text |

### Data Visualization Colors

| Name | Hex | Usage |
|------|-----|-------|
| **Semantic Green** | `#22c55e` (light) / `#4ade80` (dark) | Positive change, low short % |
| **Semantic Red** | `#ef4444` (light) / `#f87171` (dark) | Negative change, high short % |
| **Treemap Green** | `#33B074` | Low short position end of scale |
| **Treemap Red/Coral** | `#EC5D5E` | High short position end of scale |
| **Destructive Red** | `#E0291B` | Error states, destructive actions |

### Extended Palette (UI)

| Name | Hex | Usage |
|------|-----|-------|
| **Warm Border (light)** | `#E4DDDA` | Borders, dividers |
| **Warm Border (dark)** | `#302824` | Dark mode borders |
| **Muted BG (light)** | `#F3F1EE` | Muted backgrounds, inputs |
| **Muted BG (dark)** | `#1F1F1F` | Dark mode muted areas |
| **Muted Text (light)** | `#7A706B` | Secondary text |
| **Muted Text (dark)** | `#B8A88A` | Dark mode secondary text |
| **Card BG (dark)** | `#121212` | Slightly lifted dark surface |

### Industry Sector Colors (for categorization)

| Sector | Color |
|--------|-------|
| Banking | Emerald-500 (`#10b981`) |
| Mining | Amber-500 (`#f59e0b`) |
| Healthcare | Pink-500 (`#ec4899`) |
| Technology | Blue-500 (`#3b82f6`) |
| Retail | Purple-500 (`#a855f7`) |
| Telecom | Cyan-500 (`#06b6d4`) |
| Financial | Indigo-500 (`#6366f1`) |
| Conglomerate | Orange-500 (`#f97316`) |

---

## 5. Typography

### Font Families

| Role | Font | Weights | Fallbacks |
|------|------|---------|-----------|
| **Primary** (body, UI, data) | **IBM Plex Mono** | 300, 400, 500, 600, 700 | JetBrains Mono, Fira Code, ui-monospace, monospace |
| **Display** (headings) | **Space Grotesk** | 400, 500, 600, 700 | system-ui, sans-serif |

### Why These Fonts
- **IBM Plex Mono**: Reinforces the terminal aesthetic. Every character is the same width — perfect for financial data alignment. Clean and highly legible at small sizes.
- **Space Grotesk**: Geometric sans-serif that contrasts with the monospace body. Used sparingly for large headings to create visual hierarchy without abandoning the tech feel.

### Type Scale

| Context | Style |
|---------|-------|
| Hero H1 | `text-4xl → text-7xl`, `font-extrabold`, `tracking-tight` |
| Section H2 | `text-3xl → text-5xl`, `font-bold`, `tracking-tight` |
| Page H1 | `text-2xl → text-3xl`, `font-bold`, `tracking-tight` |
| Card Title | `text-2xl`, `font-semibold`, `tracking-tight` |
| Body text | `text-lg`, `leading-relaxed` |
| Nav items | `text-sm`, `font-medium` |
| Data labels | `text-[10px]`, `uppercase`, `font-semibold`, `tracking-wider` |
| Data values | `font-mono`, `text-sm`, `tabular-nums` |

### Text Treatments
- **Gradient text** on hero headings: `bg-gradient-to-r from-primary via-accent to-primary` with `bg-clip-text text-transparent`
- **Glow text** in dark mode: Multi-layered amber `text-shadow` for phosphor effect
- **ALL CAPS small labels** for data fields (e.g., "SHORT PERCENTAGE", "INDUSTRY")
- Numbers always use `tabular-nums` for column alignment

---

## 6. Visual Effects & Textures

### Amber Glow (Signature Effect)
The defining visual element — amber light radiating from interactive elements in dark mode:
```
Box glow:    0 0 30px -5px hsl(32 100% 65% / 0.4)
Text glow:   0 0 6px / 12px / 24px amber at decreasing opacities
Pulse glow:  Animated box-shadow oscillating over 2-3 seconds
```

### Scanlines
Subtle CRT scanline overlay using repeating horizontal lines:
- 2px transparent, 2px dark — repeating
- Light mode: 3% opacity
- Dark mode: 5% opacity

### Glass / Frosted Effect
Header and dropdowns use `backdrop-blur-xl` (24px blur) with semi-transparent backgrounds:
- Light: `background: hsl(var(--background) / 0.85)`
- Dark: `background: hsl(0 0% 8% / 0.9)` + inset amber glow

### Paper Texture (Light Mode)
Subtle SVG fractal noise overlay with `background-blend-mode: soft-light` — gives the light theme a warm, slightly textured parchment feel.

### Phosphor-In Animation
Content reveals with a slight blur-to-sharp transition (0.3s) — mimicking a CRT phosphor warming up.

### Cursor Blink
Terminal-style blinking cursor animation (1s step-end) — used decoratively.

---

## 7. Imagery & Asset Guidelines

### Photography / Illustration Style
- **No stock photography** — the brand is data-forward, not lifestyle
- Prefer **data visualizations, charts, and heatmaps** as hero imagery
- Screenshots of the actual platform are the primary marketing asset
- When illustration is needed, lean into the **terminal/retro-tech aesthetic** — circuit boards, phosphor screens, ticker tapes

### Logo Usage Rules
- Minimum clear space: 1x the height of the bear's head on all sides
- Dark backgrounds: Use full-color logo (the flames and bear pop)
- Light backgrounds: Full-color or monochrome black
- Never stretch, rotate, or alter the logo proportions
- The wordmark "Shorted" always appears in **bold monospace** (IBM Plex Mono 700) next to the icon

### Icon Treatment
- Use Lucide icons exclusively (line-style, consistent 24px base)
- Icon color follows text color hierarchy — `foreground` for primary, `muted-foreground` for secondary
- Common sizes: `16px` (inline), `20px` (nav/buttons), `24px` (feature cards)

### OG Image / Social Cards
- Dimensions: 1200 x 630px
- Generated dynamically at `/opengraph-image`
- Should feature: logo, page title, amber accent, dark background
- Stock pages include: stock code, short percentage, sparkline

---

## 8. Layout & Spacing Principles

### Grid System
- Max container width: **1400px**, centered with **2rem** padding
- Responsive breakpoints: 640 / 768 / 1024 / 1280 / 1400px
- Typical grid: `1 → 2 → 3 columns` across mobile → tablet → desktop

### Border Radius
- Base radius: **6px** (soft but not bubbly)
- Cards: 6px
- Buttons/inputs: 6px
- Badges/pills: full rounded (9999px)
- Feature containers: 12-16px for larger panels

### Spacing Rhythm
- Base unit: **4px**
- Component padding: 24px (`p-6`)
- Section padding: 80px → 128px vertically
- Header height: 64px (`h-16`)
- Sidebar: 64px collapsed → 256px expanded

### Shadows
Custom amber-tinted shadows rather than generic gray:
- Small: `0 0 10px -3px amber/30%`
- Medium: `0 0 20px -5px amber/40%`
- Large: `0 0 30px -5px amber/50%`
- Terminal inset: `inset 0 0 20px -10px amber/20%`

---

## 9. Component Reference

### Cards
- Rounded borders, subtle shadow
- Light: white-ish card on cream background
- Dark: `#121212` card on `#0C0C0C` background
- Featured cards get an amber border tint (`border-primary/20`)

### Buttons
- **Primary**: Amber background, dark text — with amber shadow
- **Secondary**: Avocado green background
- **Ghost**: Transparent, text-only hover state
- **Outline**: Border only, fills on hover
- All buttons: 6px radius, smooth color transitions

### Data Tables
- Zebra-free — rely on borders between rows
- Hover: subtle muted background
- Header: muted text, uppercase-ish styling
- Cells: 16px padding, left-aligned text, right-aligned numbers

### Charts & Data Viz
- **Line/Area**: Amber stroke, gradient fill fading to transparent
- **Sparklines**: Green for positive, red for negative, with glow filter
- **Treemaps**: Green-to-red continuous scale based on short %
- **Gauges**: Semi-circle with red→orange→yellow→green gradient
- Axes and ticks: amber-tinted, 10px font
- Tooltips: Dark slate background, white text, thin border

---

## 10. Animation Guidelines

### Principles
- Animations should feel like **hardware warming up**, not software bouncing
- Prefer **ease-in-out** curves at 2-4 second durations for ambient effects
- **Stagger** related elements by 50ms increments
- Interactive feedback should be quick (200-300ms) with `ease-out`

### Key Animations
| Effect | Duration | Curve | When to use |
|--------|----------|-------|-------------|
| Phosphor-in | 0.3s | ease-out | Content appearing |
| Glow pulse | 2-3s | ease-in-out | Active/important elements |
| Cursor blink | 1s | step-end | Decorative terminal feel |
| Slide-up-fade | 0.4s | ease-out | Panels, modals entering |
| Shimmer | 2s | linear | Loading states |
| Gradient sweep | 3s | ease | Hero text, banners |

---

## 11. Dark Mode vs. Light Mode

| Element | Light Mode | Dark Mode |
|---------|-----------|-----------|
| Background | Warm parchment `#F9F8F5` | Terminal black `#0C0C0C` |
| Text | Chocolate brown `#4A3B34` | Warm sand `#E8DDB5` |
| Amber accent | Solid, no glow | **Glowing** — text-shadow + box-shadow |
| Scanlines | 3% opacity | 5% opacity |
| Texture | Paper noise overlay | None (clean black) |
| Cards | Near-white `#FDFCFA` | Lifted black `#121212` |
| Borders | Warm gray `#E4DDDA` | Dark warm `#302824` |
| Phosphor blur | 0px | 1px (slight softness) |

**Dark mode is the primary/hero presentation.** Marketing materials should default to dark mode — this is where the amber glow aesthetic shines.

---

## 12. Brand Voice in Assets

### Copywriting Style
- **Concise and data-first** — lead with numbers, not adjectives
- **Lowercase navigation** — "top shorted", "dashboard", "reports"
- **ALL CAPS for labels** — "SHORT PERCENTAGE", "INDUSTRY", "MARKET CAP"
- **Australian English** — favour, analyse, colour
- **Always include disclaimer** — "Data sourced from ASIC with T+4 trading day delay. Not financial advice."

### Taglines for Assets
- "Decode Market Sentiment"
- "Track What the Market Is Shorting"
- "Official ASIC Short Position Data for ASX Stocks"
- "See What the Bears Are Betting On"
- "Updated Daily. Data-Driven. No Noise."

---

## 13. Asset Specifications

### Sizes Needed

| Asset | Dimensions | Format | Notes |
|-------|-----------|--------|-------|
| **Favicon** | 32x32, 16x16 | ICO/PNG | Bear icon simplified |
| **App Icon** | 192x192, 512x512 | PNG | Square, padded |
| **OG Image** | 1200x630 | PNG/JPG | Dark bg, logo + tagline |
| **Twitter Card** | 1200x628 | PNG/JPG | Same as OG |
| **Banner (wide)** | 1920x480 | PNG | For GitHub, blog headers |
| **Square promo** | 1080x1080 | PNG | Social media posts |
| **Logo (horizontal)** | Variable, h=64px | SVG/PNG | Icon + "Shorted" wordmark |
| **Logo (icon only)** | 64x64 to 512x512 | SVG/PNG | Bear emblem only |
| **Email header** | 600x200 | PNG | Logo + subtle amber glow |

### File Format Preferences
- **SVG** for logos and icons (scalable)
- **PNG** for assets with transparency
- **WebP** for web-optimized raster images
- **JPEG** only for photographic content (none currently)

---

## 14. Do's and Don'ts

### Do
- Use the amber glow on dark backgrounds — it's the signature
- Keep things dense and data-focused
- Use monospace type for anything that represents data
- Maintain warm tones — even "neutral" grays should lean warm
- Show real data/screenshots in marketing materials
- Let the bear mascot be bold and aggressive — it represents conviction

### Don't
- Use pure white (`#FFFFFF`) or pure black (`#000000`) — always warm-shifted
- Use generic stock photography
- Add decorative illustrations that don't serve the data
- Use rounded/bubbly UI that conflicts with the terminal aesthetic
- Use serif fonts or handwriting fonts
- Apply the glow effect to everything — it should highlight, not overwhelm
- Use the logo at tiny sizes where the bear detail is lost — switch to minimal mark

---

## 15. Color Swatches (Quick Reference)

```
AMBER (Primary)     ██████  #FFA94D
TERRACOTTA (Accent) ██████  #D16A47
AVOCADO (Secondary) ██████  #87A96B
TERMINAL BLACK      ██████  #0C0C0C
WARM SAND           ██████  #E8DDB5
PARCHMENT           ██████  #F9F8F5
CHOCOLATE           ██████  #4A3B34
SEMANTIC GREEN      ██████  #22C55E
SEMANTIC RED        ██████  #EF4444
TREEMAP GREEN       ██████  #33B074
TREEMAP CORAL       ██████  #EC5D5E
MUTED (Light)       ██████  #F3F1EE
MUTED (Dark)        ██████  #1F1F1F
BORDER (Light)      ██████  #E4DDDA
BORDER (Dark)       ██████  #302824
```

---

*Last updated: February 2026*
*Source of truth: `web/src/app/globals.css`, `web/tailwind.config.ts`, `web/src/@/config/site.ts`*
