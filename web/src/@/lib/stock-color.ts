// Deterministic palette pick for $TICKER chips on /news. Stable across
// renders so the same ticker always uses the same colour. Avoids
// monochrome orange overload while staying within the brand range
// (warm + cool + neutral, all desaturated enough not to fight the
// dark theme).

interface StockChipPalette {
  // Tailwind classes for the chip on top of a dark image overlay
  // (with backdrop-blur). border + bg + text triplet.
  onImage: string;
  // For chip on a card body (no image background).
  onCard: string;
}

// onCard text: `-700` in light mode meets WCAG AA on the pale `/10` tint over
// a white card; `dark:-300` keeps the original bright shade on the dark card.
// (A single `-300` failed contrast on light cards — Lighthouse a11y flag.)
const PALETTES: StockChipPalette[] = [
  {
    onImage: "border-orange-500/40 bg-zinc-950/80 text-orange-300",
    onCard: "bg-orange-500/10 text-orange-700 dark:text-orange-300 border border-orange-500/30",
  },
  {
    onImage: "border-sky-500/40 bg-zinc-950/80 text-sky-300",
    onCard: "bg-sky-500/10 text-sky-700 dark:text-sky-300 border border-sky-500/30",
  },
  {
    onImage: "border-emerald-500/40 bg-zinc-950/80 text-emerald-300",
    onCard: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border border-emerald-500/30",
  },
  {
    onImage: "border-violet-500/40 bg-zinc-950/80 text-violet-300",
    onCard: "bg-violet-500/10 text-violet-700 dark:text-violet-300 border border-violet-500/30",
  },
  {
    onImage: "border-rose-500/40 bg-zinc-950/80 text-rose-300",
    onCard: "bg-rose-500/10 text-rose-700 dark:text-rose-300 border border-rose-500/30",
  },
  {
    onImage: "border-amber-500/40 bg-zinc-950/80 text-amber-300",
    onCard: "bg-amber-500/10 text-amber-700 dark:text-amber-300 border border-amber-500/30",
  },
  {
    onImage: "border-cyan-500/40 bg-zinc-950/80 text-cyan-300",
    onCard: "bg-cyan-500/10 text-cyan-700 dark:text-cyan-300 border border-cyan-500/30",
  },
  {
    onImage: "border-fuchsia-500/40 bg-zinc-950/80 text-fuchsia-300",
    onCard: "bg-fuchsia-500/10 text-fuchsia-700 dark:text-fuchsia-300 border border-fuchsia-500/30",
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
