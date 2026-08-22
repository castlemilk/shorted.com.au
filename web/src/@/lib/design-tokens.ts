/**
 * The Melbourne Terminal — token registry.
 *
 * This is documentation that cannot lie: `design-tokens.test.ts` parses
 * `src/styles/globals.css` and fails if any value here disagrees with the value
 * the app actually ships, or if a token listed here has been deleted. A style
 * guide that drifts from the stylesheet is worse than no style guide, because
 * people then design against it.
 *
 * Values are stored exactly as globals.css declares them: HSL triplets for the
 * shadcn-style semantic tokens (consumed as `hsl(var(--x))`), raw hex for the
 * chart/semantic pair (consumed as `var(--x)` directly). That split is itself a
 * trap worth documenting — see `TOKEN_FORMS` below.
 */

export type TokenForm = "hsl-triplet" | "hex";

export type Token = {
  /** CSS custom property name, without the leading `--`. */
  name: string;
  /** What it is for, in one line. */
  role: string;
  light: string;
  dark: string;
  form: TokenForm;
};

export const TOKEN_FORMS: Record<TokenForm, string> = {
  "hsl-triplet":
    "Bare `H S% L%` — always consumed as hsl(var(--token)). Writing var(--token) alone silently renders nothing.",
  hex: "A literal colour — consumed as var(--token). Wrapping it in hsl() silently renders nothing.",
};

/** Surfaces, ink and structure. */
export const SURFACE_TOKENS: Token[] = [
  { name: "background", role: "Page — warm paper / CRT black", light: "40 25% 97%", dark: "0 0% 5%", form: "hsl-triplet" },
  { name: "card", role: "Raised surface", light: "40 20% 99%", dark: "0 0% 7%", form: "hsl-triplet" },
  { name: "foreground", role: "Body ink — chocolate / warm sand", light: "19 18% 24%", dark: "48 52% 81%", form: "hsl-triplet" },
  { name: "muted-foreground", role: "Secondary ink, tuned to just clear AA", light: "19 12% 40%", dark: "48 20% 55%", form: "hsl-triplet" },
  { name: "muted", role: "Recessed fill — chart tracks, hover", light: "40 15% 94%", dark: "0 0% 12%", form: "hsl-triplet" },
  { name: "border", role: "Hairlines and separators", light: "32 15% 88%", dark: "32 15% 18%", form: "hsl-triplet" },
  { name: "input", role: "Control boundary — meets 1.4.11 non-text contrast", light: "32 20% 50%", dark: "32 20% 40%", form: "hsl-triplet" },
  { name: "ring", role: "Focus ring", light: "28 82% 34%", dark: "32 100% 65%", form: "hsl-triplet" },
];

/** Brand and accent. */
export const BRAND_TOKENS: Token[] = [
  { name: "primary", role: "Burnt amber / phosphor amber — links, fills, the one emphasis colour", light: "28 82% 34%", dark: "32 100% 65%", form: "hsl-triplet" },
  { name: "primary-foreground", role: "Ink on a primary fill", light: "40 25% 97%", dark: "0 0% 5%", form: "hsl-triplet" },
  { name: "secondary", role: "Avocado — toggles and secondary fills. A FILL, not text (2.6:1 on card in light)", light: "93 26% 54%", dark: "96 33% 63%", form: "hsl-triplet" },
  { name: "secondary-text", role: "Deep olive — the text-safe olive, 6.6:1 on card", light: "93 40% 26%", dark: "96 33% 63%", form: "hsl-triplet" },
  { name: "accent", role: "Clay rust — labels and alerts. Never carries data meaning", light: "16 59% 55%", dark: "19 71% 60%", form: "hsl-triplet" },
];

/**
 * Direction of movement, and nothing else. Two pairs on purpose: the bright
 * fills are for marks (dots, bars, chart strokes), the darker `-text` pair is
 * for figures, because #22c55e is 2.23:1 on the light card.
 */
export const SEMANTIC_TOKENS: Token[] = [
  { name: "semantic-green", role: "Increase / max — as a MARK", light: "#22c55e", dark: "#4ade80", form: "hex" },
  { name: "semantic-red", role: "Decrease / min — as a MARK", light: "#ef4444", dark: "#f87171", form: "hex" },
  { name: "semantic-green-text", role: "Increase / max — as TEXT (4.93:1 on card)", light: "#15803d", dark: "#4ade80", form: "hex" },
  { name: "semantic-red-text", role: "Decrease / min — as TEXT (6.42:1 on card)", light: "#b91c1c", dark: "#f87171", form: "hex" },
];

/** Chart palette — warm, and deliberately not the semantic pair. */
export const CHART_TOKENS: Token[] = [
  { name: "red", role: "Chart rust", light: "#D16A47", dark: "#E07E50", form: "hex" },
  { name: "green", role: "Chart avocado", light: "#87A96B", dark: "#A0C080", form: "hex" },
  { name: "line-stroke", role: "Primary series stroke", light: "#FFA94D", dark: "#FFA94D", form: "hex" },
];

export const ALL_TOKENS = [
  ...SURFACE_TOKENS,
  ...BRAND_TOKENS,
  ...SEMANTIC_TOKENS,
  ...CHART_TOKENS,
];

/** Radius ladder — corners soften as surfaces grow. Base is `--radius: 0.375rem`. */
export const RADIUS_SCALE = [
  { px: 2, tw: "rounded-sm", use: "pills, ticks" },
  { px: 4, tw: "rounded", use: "chips, bars" },
  { px: 6, tw: "rounded-md", use: "controls" },
  { px: 8, tw: "rounded-lg", use: "tiles" },
  { px: 12, tw: "rounded-xl", use: "cards" },
  { px: 16, tw: "rounded-2xl", use: "banners" },
] as const;

/** The type roles, and the boundary between reading and operating. */
export const TYPE_SCALE = [
  { role: "display", sample: "Bondi Beach", spec: "Newsreader 600 · 36–60px · −0.02em", cls: "font-serif text-4xl font-semibold sm:text-6xl" },
  { role: "headline", sample: "How it compares", spec: "Newsreader 600 · 18px", cls: "font-serif text-lg" },
  { role: "section", sample: "People & housing", spec: "Newsreader 600 · 16px", cls: "font-serif text-base" },
  { role: "stat", sample: "$3.42M", spec: "Plex Mono 600 · 15–27px · tabular-nums", cls: "font-mono text-2xl font-semibold tabular-nums" },
  { role: "body", sample: "Median house price by suburb, from state Valuer-General settled transfers.", spec: "Plex Mono 400 · 14px/1.5", cls: "text-sm" },
  { role: "label / eyebrow", sample: "Household debt-to-income", spec: "Plex Mono 400 · 12px · +0.16em caps", cls: "font-mono text-xs uppercase tracking-[0.16em] text-muted-foreground" },
] as const;

export const DO_RULES = [
  "Set every numeral in mono with tabular-nums so columns align down a grid.",
  "Keep the serif for titles and section headlines only — it marks where the product stops being an instrument and starts being a publication.",
  "Use the one amber price ramp at every drill level, so colour means the same thing on the national, state and locator maps.",
  "Show what the data cannot say: an unpriced suburb states that plainly instead of rendering a zero.",
  "Close every data surface with source, vintage and licence.",
  "Rank only against a population you can name in the label.",
] as const;

export const DONT_RULES = [
  "Purple-blue gradients, gradient text, or glassmorphism by default.",
  "Identical icon-card grids down a whole page — vary density and rhythm per section.",
  "Red or green for anything but direction of movement.",
  "Pure black or pure white; every neutral carries warmth.",
  "The bright semantic pair as small text — that is what the -text variants are for.",
  "Composite scores invented in the UI: no source publishes them, so we cannot defend them.",
] as const;
