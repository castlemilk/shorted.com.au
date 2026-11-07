import { unstable_cache } from "next/cache";

/**
 * One answer that many renders or requests read, held in one unstable_cache
 * entry for `revalidate` seconds.
 *
 * This keeps the sharing a plain POST had from the data cache (one call per
 * window, however many routes or requests ask) without its failure mode: an
 * empty or failed answer held for the whole window. `read` must throw when its
 * answer is empty or failed. unstable_cache stores only what it returns, so a
 * throw is never held and the next read asks again.
 *
 * Use it for a read that many routes or requests share: a force-dynamic page
 * (/industry), a list every stock page ranks against. A read one route makes
 * per regeneration takes the route policy instead (`next` on
 * serverFetchWithUserAgent, applyRoutePolicy in config.ts).
 *
 * `tags` let a revalidation ping refresh the entry before its window ends.
 * Every page that reads the entry carries them too, so a tag busted on every
 * sync expires every one of those pages.
 */
export function sharedRead<T>(
  keyParts: string[],
  revalidate: number,
  read: () => Promise<T>,
  tags?: string[],
): Promise<T> {
  return unstable_cache(read, keyParts, {
    revalidate,
    ...(tags && tags.length > 0 ? { tags } : {}),
  })();
}
