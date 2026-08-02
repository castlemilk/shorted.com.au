/**
 * A party's mark: a rounded monogram tile in the party's palette colour.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THIS IS DELIBERATELY NOT A PARTY LOGO, AND IT NEVER WILL BE.
 * ────────────────────────────────────────────────────────────────────────────
 * Two reasons, and both of them outrank "it would look better":
 *
 *   1. TRADEMARK. Party logos are registered marks owned by the parties. We have
 *      no licence to reproduce them, and none of the open licences this feature
 *      runs on (APH CC BY-NC-ND, AEC CC BY 4.0, Wikimedia CC BY / CC BY-SA)
 *      conveys one. Every other image in this subsystem carries a licence we can
 *      point at — a portrait will not render at all without its attribution —
 *      and a logo would be the one asset here that could not.
 *
 *   2. NO ENDORSEMENT. The AEC's own terms require that its data not be used in
 *      a way suggesting the AEC endorses us, and the same posture is what the
 *      whole influence layer runs on: we publish what a source recorded and
 *      imply nothing. A party's own brand mark rendered on our page reads as
 *      affiliation. A flat monogram in a palette colour reads as a key.
 *
 * So the mark is DRAWN IN CODE from two facts we already hold — the AEC
 * abbreviation and the palette colour keyed off it. It is generated imagery
 * neither: `web/scripts/politics-icons` produces the icon set, and a party's
 * identity is deliberately outside it. Nothing here loads an asset at all.
 *
 * CLIENT-SAFE BY CONSTRUCTION: this file imports `cn` and
 * `@/lib/politics/party-palette` (pure data, split out of the d3-heavy housing
 * module for exactly this reason) and nothing else. It must never reach for
 * `compliance.tsx` or a `~/gen/…` protobuf module — see client-boundary.test.ts.
 */

import { cn } from "@/lib/utils";
import { partyColorFromAb, partyLabel, PARTY_OTHER_COLOR } from "@/lib/politics/party-palette";

/** Two sizes: `sm` for a table row or a chip, `md` for a card header. */
export type PartyMarkSize = "sm" | "md";

const SIZES: Record<PartyMarkSize, { box: number; radius: number; font: number }> = {
  sm: { box: 20, radius: 6, font: 9 },
  md: { box: 28, radius: 8, font: 11 },
};

/** The two theme inks. Nothing else is ever drawn on a tile. */
const INK_DARK = "#2b2620";
const INK_LIGHT = "#fdfbf6";

function channels(hex: string): [number, number, number] {
  const raw = hex.replace("#", "");
  const full = raw.length === 3 ? raw.split("").map((c) => c + c).join("") : raw;
  return [0, 1, 2].map((i) => parseInt(full.slice(i * 2, i * 2 + 2), 16) / 255) as [
    number,
    number,
    number,
  ];
}

function toHex(rgb: [number, number, number]): string {
  return `#${rgb
    .map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, "0"))
    .join("")}`;
}

/** WCAG 2.x relative luminance. */
function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map((v) =>
    v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4,
  ) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/**
 * The ink that reads best on a given tile: whichever of the two theme inks wins
 * on contrast, rather than a fixed lightness threshold.
 *
 * A threshold gets the mid-tones wrong in the direction that matters. One
 * Nation's #e8842a sits just under any sensible cut, so a threshold put PALE ink
 * on a bright amber tile — 2.6:1, unreadable — when the dark ink was sitting
 * there at 5.6:1.
 */
export function markInk(background: string): string {
  return contrast(background, INK_DARK) >= contrast(background, INK_LIGHT)
    ? INK_DARK
    : INK_LIGHT;
}

/**
 * The tile a mark actually renders with: the party's colour, DEEPENED only as
 * far as legibility requires.
 *
 * THE PALETTE WAS NOT DESIGNED FOR TEXT. `@/lib/politics/party-palette` picks
 * fills for a choropleth, where nothing is written on top; several of its
 * mid-tones (Labor's #d9544d, the Liberal Democrats' #4f7fa8) clear 4.5:1
 * against NEITHER ink — the best either can manage is about 4:1. A monogram is
 * type, so it has to clear.
 *
 * Rather than pick a second, unrelated set of colours — which would mean a
 * party's mark and the same party's segment on the chart beside it disagreeing —
 * the hue is kept and the tile is darkened in small steps until the light ink
 * clears. Most parties are untouched; the ones that move, move a shade.
 */
export function markTile(colour: string): { background: string; ink: string } {
  let background = colour;
  for (let step = 0; step < 12; step += 1) {
    const ink = markInk(background);
    if (contrast(background, ink) >= 4.5) return { background, ink };
    background = toHex(channels(background).map((v) => v * 0.92) as [number, number, number]);
  }
  // Twelve steps is a ~63% darkening; nothing in the palette gets close. If a
  // colour ever did, light ink on near-black is the legible answer.
  return { background, ink: INK_LIGHT };
}

/** The label a screen reader hears, and the tooltip a mouse gets. */
export function partyMarkLabel(abbreviation: string | undefined | null): string {
  const key = (abbreviation ?? "").trim();
  // Withhold rather than guess: a row whose party we do not hold says so, in
  // words, instead of being coloured in as "Other" and quietly counted as one.
  if (!key) return "Party not recorded";
  const label = partyLabel(key);
  return label === "Other" ? `${key.toUpperCase()} (party not in our list)` : label;
}

/**
 * The monogram. The AEC abbreviation as it stands (ALP, GRN, LNP, DHJP), capped
 * at four characters so the longest historical one still fits the tile. The
 * abbreviation is never the whole story, which is why the full name is always in
 * the accessible label rather than only in a tooltip.
 */
function monogram(abbreviation: string | undefined | null): string {
  const key = (abbreviation ?? "").trim().toUpperCase();
  if (!key) return "–";
  return key.slice(0, 4);
}

export function PartyMark({
  abbreviation,
  size = "sm",
  background: backgroundOverride,
  className,
}: {
  /** AEC party abbreviation, e.g. "ALP". Absent → the neutral variant. */
  abbreviation?: string | null;
  size?: PartyMarkSize;
  /**
   * A tile colour to use INSTEAD of the party's palette colour.
   *
   * ONE CALLER, AND IT IS NOT A THEMING HOOK. /compare draws each member as a
   * series, and when both members sit in the same party the second series falls
   * back to slate so two polygons are not one colour. A mark in the party's own
   * colour there would key the reader to the wrong series — so the compare
   * header cards hand the SERIES colour in, and the monogram goes on carrying
   * the party. The override still runs through `markTile`, so a colour chosen
   * for a polygon cannot arrive here as unreadable type.
   *
   * Everywhere else this is absent and the palette decides, which is what keeps
   * one party one colour across the feature.
   */
  background?: string;
  className?: string;
}) {
  const recorded = Boolean((abbreviation ?? "").trim());
  const { background, ink } = markTile(
    backgroundOverride ?? (recorded ? partyColorFromAb(abbreviation) : PARTY_OTHER_COLOR),
  );
  const label = partyMarkLabel(abbreviation);
  const text = monogram(abbreviation);
  const { box, radius, font } = SIZES[size];

  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      data-party-recorded={recorded ? "true" : "false"}
      className={cn(
        "inline-flex shrink-0 items-center justify-center font-mono font-semibold uppercase tracking-tight",
        // The neutral variant is deliberately quieter than a party's own colour:
        // "we do not hold this" should not read as loudly as a stated fact.
        !recorded && "opacity-70",
        className,
      )}
      style={{
        width: box,
        height: box,
        borderRadius: radius,
        backgroundColor: background,
        color: ink,
        fontSize: text.length > 3 ? font - 1 : font,
        lineHeight: 1,
      }}
    >
      {text}
    </span>
  );
}
