import { notFound } from "next/navigation";
import { type Stock } from "~/gen/stocks/v1alpha1/stocks_pb";
import { getStockOrNotFound } from "~/app/actions/getStock";
import { NotFoundError } from "~/app/actions/withRetry";

/**
 * The stock record that the layout and every page beneath it render around.
 * `getStockOrNotFound` is React-`cache()`d, so the second caller in one render
 * pays nothing.
 *
 * - A code the API does not know is a 404.
 * - A transient read (`undefined`) FAILS the render. Under ISR a degraded
 *   render would be BAKED into the shared cache for up to an hour; failing the
 *   generation caches nothing, and the next request regenerates.
 * - Any other error propagates untouched: Next signals control flow by
 *   throwing, and relabelling it as "transient" would hide the cause.
 *
 * Deliberately not in stock-page-shared.ts: that module stays pure so the
 * community page can import it without loading this server action.
 */
export async function loadStockOrFail(code: string): Promise<Stock> {
  let stock: Stock | undefined;
  try {
    stock = await getStockOrNotFound(code);
  } catch (err) {
    if (err instanceof NotFoundError) notFound();
    throw err;
  }
  if (!stock) {
    throw new Error(
      `stock data transiently unavailable for ${code}; failing ISR render instead of caching a degraded page`,
    );
  }
  return stock;
}
