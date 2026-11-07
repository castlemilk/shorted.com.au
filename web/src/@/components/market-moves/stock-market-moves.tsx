import Link from "next/link";
import type { MarketMoveView } from "~/@/lib/market-moves/view";
import { MarketMoveCard } from "./market-move-card";

/**
 * A stock page's market moves: the newest moves about the stock and those that
 * name it. The page reads them on the server with its other reads, so the card
 * is either in the cached HTML or absent: it never mounts later and never holds
 * a place it gives back.
 */
export function StockMarketMoves({
  stockCode,
  moves,
}: {
  stockCode: string;
  moves: ReadonlyArray<MarketMoveView>;
}) {
  if (moves.length === 0) return null;
  return (
    <section
      aria-labelledby="overview-market-moves-heading"
      className="rounded-lg border bg-card"
    >
      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <h2 id="overview-market-moves-heading" className="text-sm font-medium">
          Market moves
        </h2>
        <Link
          href="/market-moves"
          prefetch={false}
          className="text-xs text-primary hover:underline"
        >
          All market moves →
        </Link>
      </div>
      <ul className="space-y-2 border-t px-2 py-2">
        {moves.map((move) => (
          <li key={move.moveKey}>
            <MarketMoveCard
              move={move}
              variant="compact"
              currentStockCode={stockCode.toUpperCase()}
              className="border-y-0 border-r-0 rounded-md"
            />
          </li>
        ))}
      </ul>
    </section>
  );
}
