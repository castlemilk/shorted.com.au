// Heuristic filter for stock codes coming out of the news-aggregator's
// keyword extractor. The aggregator regex-matches uppercase 3-4 letter
// tokens against the headline, which catches a lot of English stop words
// that happen to share their casing with valid tickers (NEW, BUY, GOLD,
// HAS, FOR, etc.). Those false-positives end up on news cards as
// clickable $TICKER chips that link to /shorts/CODE → 404.
//
// We can't easily fix the matcher server-side without a full re-classify
// pass on existing rows, so the frontend treats anything in this deny
// list as "no stock code" until the data is cleaned.

const STOP_WORDS = new Set<string>([
  // Common English words seen in production news_articles.stock_code
  "MARKET",
  "NEW",
  "BUY",
  "SELL",
  "BOND",
  "BONDS",
  "GOLD",
  "HAS",
  "FOR",
  "ARE",
  "AGO",
  "AVG",
  "VLW",
  "ITS",
  "ASX",
  "CEO",
  "CFO",
  "USD",
  "AUD",
  "AND",
  "THE",
  "ANY",
  "ALL",
  "ONE",
  "TWO",
  "NEW",
  "OLD",
  "LOW",
  "HIGH",
  "TOP",
  "BIG",
  "MORE",
  "LESS",
  "YOU",
  "OUR",
  "OUT",
  "GET",
  "WIN",
  "BAD",
  "RAW",
  "RED",
  "HOT",
  "WHY",
  "HOW",
  "WHO",
  "NOW",
  "DAY",
  "WAY",
]);

export function isValidStockCode(code: string | undefined | null): boolean {
  if (!code) return false;
  const trimmed = code.trim().toUpperCase();
  if (trimmed.length < 2 || trimmed.length > 5) return false;
  if (!/^[A-Z0-9]+$/.test(trimmed)) return false;
  if (STOP_WORDS.has(trimmed)) return false;
  return true;
}
