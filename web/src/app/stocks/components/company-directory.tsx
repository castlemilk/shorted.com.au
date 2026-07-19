import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { CompanyLogo } from "./company-logo";
import { screenStocks } from "~/app/actions/screenStocks";
import {
  ScreenerSortField,
  SortDirection,
} from "~/gen/shorts/v1alpha1/shorts_pb";

const DIRECTORY_SIZE = 48;

function formatMarketCap(value: number): string {
  if (!value || value <= 0) return "";
  if (value >= 1e9) return `$${(value / 1e9).toFixed(1)}B`;
  if (value >= 1e6) return `$${(value / 1e6).toFixed(0)}M`;
  return `$${Math.round(value / 1e3)}K`;
}

/** Only render logos from hosts already in next.config remotePatterns —
 *  an unlisted host makes next/image THROW at render time (500s the page). */
function safeLogoUrl(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const host = new URL(url).hostname;
    return ["storage.googleapis.com", "lh3.googleusercontent.com", "shorted.com.au"].includes(host)
      ? url
      : null;
  } catch {
    return null;
  }
}

/**
 * Server-rendered browsable company directory for /stocks: the largest ASX
 * companies (screener MV, sorted by market cap) with logos, industry and
 * current short interest. Crawlable internal links to every /shorts/[code]
 * page — previously this page was an empty search box for anonymous/crawler
 * traffic. Degrades to null if the API is unavailable (search still works).
 */
export async function CompanyDirectory() {
  let stocks;
  try {
    const res = await screenStocks(
      undefined,
      ScreenerSortField.MARKET_CAP,
      SortDirection.DESC,
      DIRECTORY_SIZE,
      0,
    );
    stocks = res?.stocks ?? [];
  } catch {
    return null;
  }
  if (!stocks.length) return null;

  return (
    <section aria-labelledby="company-directory-heading" className="mt-8">
      <div className="mb-4 flex items-baseline justify-between gap-3">
        <div>
          <h2
            id="company-directory-heading"
            className="text-lg font-semibold tracking-tight"
          >
            Browse ASX companies
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            The largest listed companies by market cap, with current short
            interest from ASIC data.
          </p>
        </div>
        <Link
          href="/screener"
          className="shrink-0 text-sm text-primary hover:underline"
        >
          Full screener
          <ArrowRight aria-hidden className="ml-1 inline h-3.5 w-3.5" />
        </Link>
      </div>

      <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {stocks.map((stock) => {
          const logo = safeLogoUrl(stock.logoUrl);
          return (
            <li key={stock.stockCode}>
              <Link
                href={`/shorts/${stock.stockCode}`}
                className="group flex items-center gap-3 rounded-xl border bg-card px-4 py-3 transition-colors hover:border-primary/40 hover:bg-muted/40"
              >
                <CompanyLogo src={logo} code={stock.stockCode} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="font-semibold">{stock.stockCode}</span>
                    {stock.shortPct > 0 && (
                      <span className="font-mono text-xs tabular-nums text-muted-foreground">
                        {stock.shortPct.toFixed(2)}% short
                      </span>
                    )}
                  </span>
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="truncate text-xs text-muted-foreground">
                      {stock.companyName || stock.stockCode}
                    </span>
                    <span className="shrink-0 text-[11px] text-muted-foreground/70">
                      {formatMarketCap(stock.marketCap)}
                    </span>
                  </span>
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
