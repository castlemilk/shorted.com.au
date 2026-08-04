// Deterministic palette pick for $TICKER chips on /news. Stable across
// renders so the same ticker always uses the same colour. Varied enough to
// avoid a wall of identical orange, but held inside the warm amber family
// the rest of the system uses: no cool hues, and no true red/green (those
// are quarantined for market direction).

interface StockChipPalette {
  // Tailwind classes for the chip on top of a dark image overlay
  // (with backdrop-blur). border + bg + text triplet.
  onImage: string;
  // For chip on a card body (no image background).
  onCard: string;
}

// onImage sits on a photo scrim, which is dark in both themes, so the `-300`
// shade is correct there unconditionally.
// onCard text: `-700`/`-800` in light mode meets WCAG AA on the pale `/10`
// tint over a white card; `dark:-300` keeps the bright shade on the dark card.
// (A single `-300` failed contrast on light cards — Lighthouse a11y flag.)
const PALETTES: StockChipPalette[] = [
  {
    onImage: "border-orange-500/40 bg-stone-950/80 text-orange-300",
    onCard: "bg-orange-500/10 text-orange-700 dark:text-orange-300 border border-orange-500/30",
  },
  {
    onImage: "border-amber-500/40 bg-stone-950/80 text-amber-300",
    onCard: "bg-amber-500/10 text-amber-700 dark:text-amber-300 border border-amber-500/30",
  },
  {
    onImage: "border-yellow-500/40 bg-stone-950/80 text-yellow-300",
    onCard: "bg-yellow-500/10 text-yellow-800 dark:text-yellow-300 border border-yellow-500/30",
  },
  {
    onImage: "border-lime-600/40 bg-stone-950/80 text-lime-300",
    onCard: "bg-lime-600/10 text-lime-800 dark:text-lime-300 border border-lime-600/30",
  },
  {
    onImage: "border-stone-500/40 bg-stone-950/80 text-stone-300",
    onCard: "bg-stone-500/10 text-stone-700 dark:text-stone-300 border border-stone-500/30",
  },
];

// Tiny string hash — FNV-1a 32-bit. Deterministic, ASCII-only is fine.
function hash(code: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < code.length; i++) {
    h ^= code.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function stockChipPalette(code: string | undefined | null): StockChipPalette {
  if (!code) return PALETTES[0]!;
  const idx = hash(code.toUpperCase()) % PALETTES.length;
  return PALETTES[idx]!;
}
