"use client";

import { StockNewsTab } from "./stock-news-tab";

interface StockNewsFeedProps {
  stockCode: string;
  limit?: number;
}

/**
 * Legacy export — superseded by `StockNewsTab`, which renders the feed and
 * a deduped related-coverage section in one card. Kept as a thin shim so
 * existing imports keep working: renders the same feed card (same
 * ["stock-news", stockCode, limit] query key) without the related section.
 */
export function StockNewsFeed({ stockCode, limit = 10 }: StockNewsFeedProps) {
  return <StockNewsTab stockCode={stockCode} limit={limit} relatedLimit={0} />;
}
