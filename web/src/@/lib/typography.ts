/**
 * Canonical typography tokens — the one type system for Shorted.
 *
 * "Amber Terminal Glow": IBM Plex Mono (the app-wide `--font-sans`) is the
 * default face for chrome, data, labels and body. Newsreader serif
 * (`font-serif`) is reserved for *display* headlines — page titles and major
 * section headlines only. Card titles, table headers, buttons, nav, and every
 * number stay mono per the design context (`.impeccable.md`).
 *
 * Reference surface: `app/industry-intelligence/industry-intelligence-client.tsx`.
 * Use these tokens instead of hand-rolling heading classes so equivalent
 * heading levels never drift in weight, size, or tracking.
 */

/**
 * Page headline (h1). Serif display face. Matches the industry-intelligence
 * reference exactly. One per page.
 */
export const pageTitle =
  "font-serif text-3xl font-bold tracking-tight text-balance sm:text-4xl";

/**
 * Major section headline (h2). Serif display face, a step down from the page
 * title. For standalone section breaks with whitespace around them — not for
 * dense in-card sub-labels (those stay mono).
 */
export const sectionTitle = "font-serif text-2xl font-semibold tracking-tight text-balance";

/**
 * Eyebrow / kicker label — the small uppercase mono lead-in above a headline.
 * Canonical tracking is 0.16em. Muted by default; pair with `text-primary`
 * where a page wants the accent kicker.
 */
export const eyebrow =
  "font-mono text-xs uppercase tracking-[0.16em] text-muted-foreground";

/**
 * Lede / dek — the muted intro paragraph that sits directly under a page
 * title. Establishes the vertical rhythm (`mt-2`) and reading measure
 * (`max-w-2xl`) for the standard left-aligned page header. Compose overrides
 * for centred hero variants, e.g. `cn(lede, "mx-auto text-lg")`.
 */
export const lede = "mt-2 max-w-2xl text-muted-foreground";

/**
 * Card-title tier — intentionally NOT a token. shadcn's <CardTitle> already
 * owns this level (mono, `text-lg`, terminal chrome); duplicating it here would
 * just invite drift. Use <CardTitle> from `@/components/ui/card` for card and
 * widget headers, and keep dashboard/control-bar labels mono. Serif is for the
 * page `pageTitle` (h1) and standalone `sectionTitle` (h2) only.
 */
