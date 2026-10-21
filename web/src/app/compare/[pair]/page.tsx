import { type Metadata } from "next";
import { industryLabel } from "~/@/lib/industry-placeholder";
import { pageTitle } from "~/@/lib/typography";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { siteConfig } from "~/@/config/site";
import {
  Breadcrumbs,
  BreadcrumbStructuredData,
} from "~/@/components/seo/breadcrumbs";
import { loadStockOrFail } from "~/app/shorts/[stockCode]/stock-page-data";
import { JsonLd } from "~/@/components/seo/json-ld";

type PageProps = {
  params: Promise<{ pair: string }>;
};

/**
 * Two codes GetStock accepts (validateStockCode in services/shorts: three or
 * four alphanumerics), so any other pair is a 404 before a read. The API
 * answers a shorter code InvalidArgument, which loadStockOrFail takes for a
 * failed read: the render would fail, cache nothing, and fail again on every
 * request.
 */
const PAIR_RE = /^([A-Z0-9]{3,4})-vs-([A-Z0-9]{3,4})$/i;

function parsePair(pair: string): [string, string] | null {
  const m = PAIR_RE.exec(pair);
  if (!m) return null;
  const a = m[1]!.toUpperCase();
  const b = m[2]!.toUpperCase();
  if (a === b) return null;
  return [a, b];
}

function canonicalSlug(a: string, b: string): string {
  const [lo, hi] = a < b ? [a, b] : [b, a];
  return `${lo}-vs-${hi}`;
}

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const { pair } = await params;
  const parsed = parsePair(pair);
  if (!parsed) {
    return { title: "Comparison Not Found" };
  }
  const [a, b] = parsed;
  const canonical = canonicalSlug(a, b);
  const [lo, hi] = canonical.split("-vs-") as [string, string];

  const title = `${lo} vs ${hi} — ASX Short Interest Comparison`;
  const description = `Side-by-side comparison of ${lo} and ${hi} short positions on the ASX using official ASIC data. Short interest %, industry, reported short positions, and trend — updated daily with T+4 delay.`;

  return {
    title,
    description,
    keywords: [
      `${lo} vs ${hi}`,
      `${lo} vs ${hi} short interest`,
      `${lo} vs ${hi} ASX comparison`,
      `${lo} or ${hi} shorted`,
      "ASX peer comparison short interest",
      "ASIC short position comparison",
    ],
    openGraph: {
      title,
      description,
      url: `${siteConfig.url}/compare/${canonical}`,
      siteName: siteConfig.name,
      type: "article",
      locale: "en_AU",
      // No `images` key: this route ships its own opengraph-image.tsx and an
      // explicit `images` here would SHADOW the file convention.
    },
    twitter: {
      site: "@shorted___",
      creator: "@shorted___",
      card: "summary_large_image",
      title,
      description,
    },
    alternates: {
      canonical: `${siteConfig.url}/compare/${canonical}`,
      languages: {
        "en-AU": `${siteConfig.url}/compare/${canonical}`,
        "x-default": `${siteConfig.url}/compare/${canonical}`,
      },
    },
  };
}

export const revalidate = 86400;

// On-demand ISR, the stock pages' rule: a dynamic segment is statically
// optimised only when generateStaticParams EXISTS. Without it every pair
// rendered per request (`private, no-store`, measured 2026-10-21) and the
// revalidate above was inert. Empty, so each pair generates on its first
// request. Its only read, getStock, runs in unstable_cache over
// serverFetchOutsideNextCache, so a regeneration cannot trip the no-store
// landmine; the daily sync's shorts-data revalidation busts it.
export const dynamicParams = true;
export function generateStaticParams(): Array<{ pair: string }> {
  return [];
}

export default async function ComparePage({ params }: PageProps) {
  const { pair } = await params;
  const parsed = parsePair(pair);
  if (!parsed) {
    notFound();
  }
  const [a, b] = parsed;
  const canonical = canonicalSlug(a, b);

  // 301 non-canonical orderings to the alphabetical form.
  if (pair !== canonical) {
    redirect(`/compare/${canonical}`);
  }

  const [lo, hi] = canonical.split("-vs-") as [string, string];

  // A code the API does not know is a 404. A transient read FAILS the render
  // instead: under ISR a 404 is cached like any page, so answering a blip with
  // notFound() would hide a live pair for up to a day (and a background
  // regeneration would replace the good page with it). A failed render caches
  // nothing and keeps serving the last good page.
  const [stockA, stockB] = await Promise.all([
    loadStockOrFail(lo),
    loadStockOrFail(hi),
  ]);

  const pctA = stockA.percentageShorted ?? 0;
  const pctB = stockB.percentageShorted ?? 0;
  const posA = stockA.reportedShortPositions ?? 0;
  const posB = stockB.reportedShortPositions ?? 0;
  const nameA = stockA.name || lo;
  const nameB = stockB.name || hi;
  const industryA = industryLabel(stockA.industry);
  const industryB = industryLabel(stockB.industry);

  const asOfIso = new Date().toISOString().slice(0, 10);
  const asOfDisplay = new Date().toLocaleDateString("en-AU", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
  const fmtInt = (n: number) =>
    n > 0 ? new Intl.NumberFormat("en-AU").format(Math.round(n)) : "—";

  const moreShorted =
    pctA > pctB ? lo : pctB > pctA ? hi : null;
  const diffPct = Math.abs(pctA - pctB);

  const breadcrumbItems = [
    { label: "Compare", href: "/compare" },
    { label: `${lo} vs ${hi}`, href: `/compare/${canonical}` },
  ];

  const webPageSchema = {
    "@context": "https://schema.org",
    "@type": "WebPage",
    name: `${lo} vs ${hi} — ASX Short Interest Comparison`,
    url: `${siteConfig.url}/compare/${canonical}`,
    description: `Side-by-side ASIC short interest comparison between ${nameA} (ASX:${lo}) and ${nameB} (ASX:${hi}).`,
    dateModified: asOfIso,
    inLanguage: "en-AU",
    isPartOf: {
      "@type": "WebSite",
      name: siteConfig.name,
      url: siteConfig.url,
    },
    about: [
      {
        "@type": "Corporation",
        name: nameA,
        tickerSymbol: lo,
        url: `${siteConfig.url}/shorts/${lo}`,
      },
      {
        "@type": "Corporation",
        name: nameB,
        tickerSymbol: hi,
        url: `${siteConfig.url}/shorts/${hi}`,
      },
    ],
    mainEntity: {
      "@type": "ItemList",
      itemListElement: [
        {
          "@type": "ListItem",
          position: 1,
          item: {
            "@type": "FinancialProduct",
            name: nameA,
            tickerSymbol: lo,
            url: `${siteConfig.url}/shorts/${lo}`,
          },
        },
        {
          "@type": "ListItem",
          position: 2,
          item: {
            "@type": "FinancialProduct",
            name: nameB,
            tickerSymbol: hi,
            url: `${siteConfig.url}/shorts/${hi}`,
          },
        },
      ],
    },
  };

  return (
    <main className="min-h-screen">
      <BreadcrumbStructuredData items={breadcrumbItems} />
      <JsonLd data={webPageSchema} />

      <div className="container mx-auto max-w-4xl px-4 py-8">
        <div className="mb-4">
          <Breadcrumbs items={breadcrumbItems} />
        </div>

        <article>
          <h1 className={pageTitle}>
            {lo} vs {hi} — ASX Short Interest Comparison
          </h1>
          <p className="mt-3 text-base text-muted-foreground leading-relaxed">
            Side-by-side comparison of short positions for{" "}
            <Link
              href={`/shorts/${lo}`}
              className="underline hover:no-underline"
            >
              {nameA} (ASX:{lo})
            </Link>{" "}
            and{" "}
            <Link
              href={`/shorts/${hi}`}
              className="underline hover:no-underline"
            >
              {nameB} (ASX:{hi})
            </Link>
            , based on official ASIC short position reports as of{" "}
            {asOfDisplay}.
          </p>

          <p className="mt-3 text-base leading-relaxed">
            {moreShorted ? (
              <>
                <strong>{moreShorted}</strong> is more heavily shorted, with{" "}
                <strong>{(moreShorted === lo ? pctA : pctB).toFixed(2)}%</strong>{" "}
                of shares reported as short positions against{" "}
                <strong>{(moreShorted === lo ? pctB : pctA).toFixed(2)}%</strong>{" "}
                for <strong>{moreShorted === lo ? hi : lo}</strong> — a gap of{" "}
                <strong>{diffPct.toFixed(2)} percentage points</strong>.
              </>
            ) : (
              <>
                Both {lo} and {hi} have the same reported short interest of{" "}
                <strong>{pctA.toFixed(2)}%</strong> as of {asOfDisplay}.
              </>
            )}
          </p>

          <section
            aria-label="Side-by-side comparison"
            className="mt-8 grid grid-cols-1 md:grid-cols-2 gap-4"
          >
            {[
              {
                code: lo,
                name: nameA,
                pct: pctA,
                positions: posA,
                industry: industryA,
              },
              {
                code: hi,
                name: nameB,
                pct: pctB,
                positions: posB,
                industry: industryB,
              },
            ].map((s) => (
              <div
                key={s.code}
                className="rounded-lg border bg-card p-4 md:p-5"
              >
                <div className="flex items-baseline justify-between gap-3">
                  <h2 className="text-xl font-semibold tracking-tight">
                    <Link
                      href={`/shorts/${s.code}`}
                      className="hover:underline"
                    >
                      {s.code}
                    </Link>
                  </h2>
                  {moreShorted === s.code && (
                    <span className="text-xs font-medium rounded-full bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200 px-2 py-0.5">
                      More shorted
                    </span>
                  )}
                </div>
                <p className="text-sm text-muted-foreground">{s.name}</p>
                <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
                  <div>
                    <dt className="text-muted-foreground">Short interest</dt>
                    <dd className="font-semibold text-base">
                      {s.pct > 0 ? `${s.pct.toFixed(2)}%` : "—"}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Reported positions</dt>
                    <dd className="font-semibold text-base">
                      {fmtInt(s.positions)}
                    </dd>
                  </div>
                  <div className="col-span-2">
                    <dt className="text-muted-foreground">Industry</dt>
                    <dd className="font-semibold text-base">
                      {s.industry || "—"}
                    </dd>
                  </div>
                </dl>
              </div>
            ))}
          </section>

          {industryA && industryB && industryA === industryB && (
            <p className="mt-6 text-sm text-muted-foreground">
              Both {lo} and {hi} operate in the{" "}
              <strong>{industryA}</strong> industry — industry-level short
              positioning may reflect broader sector sentiment rather than
              stock-specific views.
            </p>
          )}

          <p className="mt-8 text-xs text-muted-foreground">
            Source: official ASIC short position reports (T+4 delay).{" "}
            <Link href="/methodology" className="underline hover:no-underline">
              Methodology
            </Link>
            {" · "}
            <Link href="/disclaimer" className="underline hover:no-underline">
              Disclaimer — not financial advice
            </Link>
            .
          </p>
        </article>
      </div>
    </main>
  );
}
