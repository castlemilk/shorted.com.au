import { MarketMovesStrip } from "~/@/components/market-moves/market-moves-strip";
import { getHomeMarketMoves } from "~/app/actions/market-moves/getMarketMoves";

/**
 * Server-rendered "Market moves" strip for the homepage, above the Market news
 * strip: the newest notable moves the market-moves workflow posted. The read
 * is tagged market-moves:home, which the API revalidates after each change, so
 * the 24-hour homepage picks a move up within a minute of its post. Renders
 * nothing when there are none or the moves are unavailable.
 */
export async function LatestMarketMoves() {
  const moves = await getHomeMarketMoves();
  return <MarketMovesStrip moves={moves} />;
}
