import { type Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { siteConfig } from "~/@/config/site";
import {
  Breadcrumbs,
  BreadcrumbStructuredData,
} from "~/@/components/seo/breadcrumbs";
import { getStockOrNotFound } from "~/app/actions/getStock";
import { NotFoundError } from "~/app/actions/withRetry";

type PageProps = {
  params: Promise<{ pair: string }>;
};

const PAIR_RE = /^([A-Z0-9]{1,4})-vs-([A-Z0-9]{1,4})$/i;

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

async function fetchBoth(a: string, b: string) {
  return Promise.all([
    getStockOrNotFound(a).catch((err: unknown) => {
      if (err instanceof NotFoundError) throw err;
      return undefined;
    }),
    getStockOrNotFound(b).catch((err: unknown) => {
      if (err instanceof NotFoundError) throw err;
      return undefined;
    }),
  ]);
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
      images: [
        {
          url: siteConfig.ogImage,
          width: 1200,
          height: 630,
          alt: `${lo} vs ${hi} — ASX short interest comparison`,
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [siteConfig.ogImage],
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

  // If either stock genuinely doesn't exist, 404. Transient errors yield
  // undefined — we still render but with a fallback note so we don't
  // publish an empty 200.
  let stockA: Awaited<ReturnType<typeof getStockOrNotFound>> = undefined;
  let stockB: Awaited<ReturnType<typeof getStockOrNotFound>> = undefined;
  try {
    [stockA, stockB] = await fetchBoth(lo, hi);
  } catch (err) {
    if (err instanceof NotFoundError) notFound();
  }

  if (!stockA || !stockB) {
    // Don't publish a thin page on transient failures — 404 is safer for SEO
    // than indexing a page that says "data temporarily unavailable".
    notFound();
  }

  const pctA = stockA.percentageShorted ?? 0;
  const pctB = stockB.percentageShorted ?? 0;
  const posA = stockA.reportedShortPositions ?? 0;
  const posB = stockB.reportedShortPositions ?? 0;
  const nameA = stockA.name || lo;
  const nameB = stockB.name || hi;
  const industryA = stockA.industry || "";
  const industryB = stockB.industry || "";

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
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(webPageSchema) }}
      />

      <div className="container mx-auto max-w-4xl px-4 py-8">
        <div className="mb-4">
          <Breadcrumbs items={breadcrumbItems} />
        </div>

        <article>
          <h1 className="text-3xl md:text-4xl font-bold tracking-tight">
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
