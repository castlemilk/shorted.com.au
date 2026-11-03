/**
 * Whether a stock's register page may be indexed. The page must name at least
 * one current holder. A register whose every notice ceased still renders, with
 * the lanes of what was read, but it is noindex: it says what was read, not who
 * holds the stock.
 */
export function registerIsIndexable({ holders }: { holders: number }): boolean {
  return holders >= 1;
}
