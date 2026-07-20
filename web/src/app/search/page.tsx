import { type Metadata } from "next";
import { pageTitle } from "~/@/lib/typography";
import Link from "next/link";
import { Search as SearchIcon, TrendingDown, TrendingUp } from "lucide-react";
import { createConnectTransport } from "@connectrpc/connect-web";
import { createClient } from "@connectrpc/connect";
import { ShortedStocksService } from "~/gen/shorts/v1alpha1/shorts_pb";
import { siteConfig } from "~/@/config/site";
import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";
import {
  Breadcrumbs,
  BreadcrumbStructuredData,
} from "~/@/components/seo/breadcrumbs";
import { SHORTS_API_URL, serverFetchWithUserAgent } from "~/app/actions/config";

export const revalidate = 300;

interface PageProps {
  searchParams: Promise<{ q?: string }>;
}

export async function generateMetadata({
  searchParams,
}: PageProps): Promise<Metadata> {
  const { q } = await searchParams;
  const query = (q ?? "").trim();
  const base = `${siteConfig.url}/search`;
  if (!query) {
    return {
      title: "Search ASX Stocks | Shorted",
      description:
        "Search Australian Securities Exchange (ASX) stocks by code or company name. View live short positions, sentiment, and analysis.",
      alternates: { canonical: base },
      robots: { index: false, follow: true },
    };
  }
  return {
    title: `Search "${query}" | ASX Stocks | Shorted`,
    description: `Search results for "${query}" — ASX stocks matched by code or company name.`,
    alternates: { canonical: `${base}?q=${encodeURIComponent(query)}` },
    // Search-results pages are noindex by convention (Google's own guidance).
    robots: { index: false, follow: true },
  };
}

interface SearchResultStock {
  productCode: string;
  name: string;
  percentageShorted?: number;
}

async function searchStocks(query: string): Promise<SearchResultStock[]> {
  if (!query) return [];
  try {
    const transport = createConnectTransport({
      fetch: serverFetchWithUserAgent,
      baseUrl: SHORTS_API_URL,
    });
    const client = createClient(ShortedStocksService, transport);
    const resp = await client.searchStocks({
      query,
      limit: 30,
      includeDetails: false,
    });
    return resp.stocks.map((s) => ({
      productCode: s.productCode,
      name: s.name,
      percentageShorted: s.percentageShorted,
    }));
  } catch {
    return [];
  }
}

export default async function SearchPage({ searchParams }: PageProps) {
  const { q } = await searchParams;
  const query = (q ?? "").trim();
  const results = await searchStocks(query);

  const breadcrumbItems = [
    { label: "Search", href: query ? `/search?q=${encodeURIComponent(query)}` : "/search" },
  ];

  return (
    <DashboardLayout>
      <BreadcrumbStructuredData items={breadcrumbItems} />
      <section className="mb-4 flex items-center gap-3">
        <div className="rounded-lg bg-primary/10 p-2">
          <SearchIcon className="h-5 w-5 text-primary" />
        </div>
        <div>
          <h1 className={pageTitle}>
            {query ? `Search: "${query}"` : "Search ASX Stocks"}
          </h1>
          <p className="text-sm text-muted-foreground">
            {query
              ? `${results.length} match${results.length === 1 ? "" : "es"} found.`
              : "Find an ASX stock by code (e.g. BHP) or company name."}
          </p>
        </div>
      </section>

      <Breadcrumbs items={breadcrumbItems} />

      <form action="/search" method="get" className="mt-4">
        <label htmlFor="q" className="sr-only">
          Search ASX stocks
        </label>
        <div className="relative">
          <SearchIcon className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            id="q"
            name="q"
            defaultValue={query}
            placeholder="Stock code or company name…"
            className="w-full rounded-lg border bg-card py-3 pl-10 pr-4 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
          />
        </div>
      </form>

      {!query ? (
        <div className="mt-8 rounded-lg border bg-muted/30 p-8 text-center text-sm text-muted-foreground">
          Type a stock code or company name above. Try{" "}
          <Link href="/search?q=BHP" className="underline">BHP</Link>,{" "}
          <Link href="/search?q=CBA" className="underline">CBA</Link>, or{" "}
          <Link href="/search?q=mining" className="underline">mining</Link>.
        </div>
      ) : results.length === 0 ? (
        <div className="mt-8 rounded-lg border bg-muted/30 p-8 text-center text-sm text-muted-foreground">
          No stocks matched <strong>"{query}"</strong>. Try a different search
          term or browse the{" "}
          <Link href="/directory" className="underline">full directory</Link>.
        </div>
      ) : (
        <ul className="mt-6 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {results.map((s) => (
            <li key={s.productCode}>
              <Link
                href={`/shorts/${s.productCode}`}
                className="group flex items-center gap-3 rounded-lg border bg-card p-4 transition-all hover:border-primary/40 hover:shadow-md"
              >
                <span className="rounded-md bg-muted px-2 py-1 font-mono text-xs font-semibold tracking-wide">
                  {s.productCode}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium group-hover:text-primary">
                    {s.name || s.productCode}
                  </p>
                  {typeof s.percentageShorted === "number" && (
                    <p className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
                      {s.percentageShorted > 0 ? (
                        <TrendingDown className="h-3 w-3 text-rose-500" />
                      ) : (
                        <TrendingUp className="h-3 w-3 text-emerald-500" />
                      )}
                      {s.percentageShorted.toFixed(2)}% shorted
                    </p>
                  )}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </DashboardLayout>
  );
}
