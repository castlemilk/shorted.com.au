import Link from "next/link";
import { ChevronRight } from "lucide-react";
import type { MarketMoveView } from "~/@/lib/market-moves/view";
import { MarketMoveCard } from "./market-move-card";

/**
 * The homepage's "Market moves" row: the newest notable moves, compact. Renders
 * nothing when there are none, so the homepage never holds a place it gives
 * back (it is server-rendered with the page, never an island).
 */
export function MarketMovesStrip({
  moves,
}: {
  moves: ReadonlyArray<MarketMoveView>;
}) {
  if (moves.length === 0) return null;
  return (
    <section
      className="container mx-auto px-4 py-6"
      aria-labelledby="home-market-moves-heading"
    >
      <div className="mb-4 flex items-center justify-between">
        <h2
          id="home-market-moves-heading"
          className="text-lg font-semibold tracking-tight text-foreground"
        >
          Market moves
        </h2>
        <Link
          href="/market-moves"
          className="group flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-primary"
        >
          All market moves
          <ChevronRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
        </Link>
      </div>
      <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {moves.map((move) => (
          <li key={move.moveKey} className="min-w-0">
            <MarketMoveCard move={move} variant="compact" className="h-full" />
          </li>
        ))}
      </ul>
    </section>
  );
}
