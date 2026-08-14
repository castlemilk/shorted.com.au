import { type Metadata } from "next";
import { pageTitle } from "~/@/lib/typography";
import Link from "next/link";
import { siteConfig } from "~/@/config/site";
import {
  Breadcrumbs,
  BreadcrumbStructuredData,
} from "~/@/components/seo/breadcrumbs";
import { getTopShortsData } from "~/app/actions/getTopShorts";
import { bailOnEmptyRender } from "~/app/actions/config";

export const metadata: Metadata = {
  title: "ASX Stock Short Interest Comparisons",
  description:
    "Compare short interest between ASX-listed stocks using official ASIC data. Side-by-side short position percentages, industry context, and trend for the most commonly compared ASX pairs.",
  keywords: [
    "ASX stock comparison",
    "ASX peer comparison short interest",
    "ASIC short position comparison",
    "compare ASX stocks shorted",
  ],
  alternates: {
    canonical: `${siteConfig.url}/compare`,
    languages: {
      "en-AU": `${siteConfig.url}/compare`,
      "x-default": `${siteConfig.url}/compare`,
    },
  },
  openGraph: {
    title: "ASX Stock Short Interest Comparisons",
    description:
      "Side-by-side comparison of short positions between ASX-listed stocks using ASIC data.",
    url: `${siteConfig.url}/compare`,
    siteName: siteConfig.name,
    type: "website",
    locale: "en_AU",
    // No `images` key: this route ships its own opengraph-image.tsx and an
    // explicit `images` here would SHADOW the file convention.
  },
};

export const revalidate = 86400;

/**
 * Generate the featured pair list deterministically from the top-shorted
 * stocks. We intersect the top-20 by short interest % and pick pairs
 * from the same industry where possible, then pad with cross-industry
 * pairs from the same top-20. This produces a stable, non-thin set of
 * comparison links for crawlers.
 */
async function buildFeaturedPairs(): Promise<
  Array<{ slug: string; a: string; b: string; industry: string }>
> {
  try {
    const data = await getTopShortsData("1m", 30, 0);
    const top = (data?.timeSeries ?? [])
      .map((ts) => ({
        code: ts.productCode,
        industry:
          (ts as { industry?: string }).industry ?? "",
      }))
      .filter((s) => !!s.code);

    const pairs: Array<{ slug: string; a: string; b: string; industry: string }> =
      [];
    const seen = new Set<string>();

    // Same-industry pairs first (naturally comparable).
    for (let i = 0; i < top.length; i++) {
      for (let j = i + 1; j < top.length; j++) {
        const a = top[i]!;
        const b = top[j]!;
        if (!a.industry || a.industry !== b.industry) continue;
        const [lo, hi] = a.code < b.code ? [a.code, b.code] : [b.code, a.code];
        const slug = `${lo}-vs-${hi}`;
        if (seen.has(slug)) continue;
        seen.add(slug);
        pairs.push({ slug, a: lo, b: hi, industry: a.industry });
        if (pairs.length >= 30) return pairs;
      }
    }

    // Pad with cross-industry pairs from top of list.
    for (let i = 0; i < top.length && pairs.length < 30; i++) {
      for (let j = i + 1; j < top.length && pairs.length < 30; j++) {
        const a = top[i]!;
        const b = top[j]!;
        const [lo, hi] = a.code < b.code ? [a.code, b.code] : [b.code, a.code];
        const slug = `${lo}-vs-${hi}`;
        if (seen.has(slug)) continue;
        seen.add(slug);
        pairs.push({ slug, a: lo, b: hi, industry: "" });
      }
    }
    return pairs;
  } catch {
    return [];
  }
}

export default async function CompareIndexPage() {
  const pairs = await buildFeaturedPairs();
  // A failed/cold fetch must not bake the "pairs are being built" shell into
  // the route cache for the whole revalidate window.
  if (pairs.length === 0) bailOnEmptyRender();

  const breadcrumbItems = [{ label: "Compare", href: "/compare" }];

  return (
    <main className="min-h-screen">
      <BreadcrumbStructuredData items={breadcrumbItems} />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            "@context": "https://schema.org",
            "@type": "CollectionPage",
            name: "ASX Stock Short Interest Comparisons",
            url: `${siteConfig.url}/compare`,
            description:
              "Side-by-side short interest comparisons for ASX-listed stocks, built from ASIC short position reports.",
            isPartOf: {
              "@type": "WebSite",
              name: siteConfig.name,
              url: siteConfig.url,
            },
            mainEntity: {
              "@type": "ItemList",
              numberOfItems: pairs.length,
              itemListElement: pairs.slice(0, 30).map((p, i) => ({
                "@type": "ListItem",
                position: i + 1,
                url: `${siteConfig.url}/compare/${p.slug}`,
                name: `${p.a} vs ${p.b}`,
              })),
            },
          }),
        }}
      />

      <div className="container mx-auto max-w-4xl px-4 py-8">
        <div className="mb-4">
          <Breadcrumbs items={breadcrumbItems} />
        </div>

        <h1 className={pageTitle}>
          ASX Stock Short Interest Comparisons
        </h1>
        <p className="mt-3 text-base text-muted-foreground max-w-2xl leading-relaxed">
          Side-by-side comparison of short positions between ASX-listed stocks
          using official ASIC short position reports. Use these pages to see
          how two stocks' reported short interest percentages, positions, and
          industry context compare — updated daily with the ASIC T+4 delay.
        </p>

        {pairs.length === 0 ? (
          <p className="mt-8 text-sm text-muted-foreground">
            Comparison pairs are being built. Please check back shortly.
          </p>
        ) : (
          <section className="mt-8">
            <h2 className="text-xl font-semibold tracking-tight mb-4">
              Featured comparisons
            </h2>
            <ul className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {pairs.map((p) => (
                <li key={p.slug}>
                  <Link
                    href={`/compare/${p.slug}`}
                    className="block rounded-md border bg-card px-3 py-2 hover:bg-accent"
                  >
                    <span className="font-medium">
                      {p.a} vs {p.b}
                    </span>
                    {p.industry ? (
                      <span className="ml-2 text-xs text-muted-foreground">
                        {p.industry}
                      </span>
                    ) : null}
                  </Link>
                </li>
              ))}
            </ul>
          </section>
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
      </div>
    </main>
  );
}
