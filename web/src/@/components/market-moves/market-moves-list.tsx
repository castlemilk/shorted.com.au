import type { MarketMoveView } from "~/@/lib/market-moves/view";
import { MarketMoveCard } from "./market-move-card";

/**
 * A column of market moves in feed order (newest observation first). The
 * /market-moves page draws one per market date; each card is its own anchor.
 */
export function MarketMovesList({
  moves,
  headingLevel = 3,
}: {
  moves: ReadonlyArray<MarketMoveView>;
  headingLevel?: 2 | 3 | 4;
}) {
  if (moves.length === 0) return null;
  return (
    <ol className="space-y-3">
      {moves.map((move) => (
        <li key={move.moveKey}>
          <MarketMoveCard move={move} headingLevel={headingLevel} />
        </li>
      ))}
    </ol>
  );
}
