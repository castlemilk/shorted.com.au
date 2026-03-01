import Link from "next/link";
import { getIndustryData } from "~/app/actions/industry/getIndustryData";

/**
 * Server-rendered "Browse by Industry" section for the homepage.
 * Provides internal links to all 31 industry pages for SEO crawlability.
 */
export async function BrowseByIndustry() {
  let industries: Awaited<ReturnType<typeof getIndustryData>>;
  try {
    industries = await getIndustryData();
  } catch {
    return null;
  }

  if (!industries || industries.length === 0) return null;

  // Filter out invalid ASIC classifications that may leak through
  const HIDDEN_INDUSTRIES = new Set(["Class Pend", "Not Applic", "Not Applicable", "Other"]);

  // Sort by average short % descending, excluding invalid labels
  const sorted = [...industries]
    .filter((i) => !HIDDEN_INDUSTRIES.has(i.name))
    .sort((a, b) => (b.avgShortPercent ?? 0) - (a.avgShortPercent ?? 0));

  return (
    <section className="container mx-auto px-4 py-6">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">
            Browse by Industry
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Explore short positions across {sorted.length} ASX industry sectors
          </p>
        </div>
        <Link
          href="/industry"
          className="text-xs text-primary hover:underline"
        >
          View all industries
        </Link>
      </div>
      <div className="flex flex-wrap gap-2">
        {sorted.map((industry) => (
          <Link
            key={industry.slug}
            href={`/industry/${industry.slug}`}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium border border-border/50 bg-muted/30 hover:bg-muted hover:border-border transition-colors"
          >
            <span>{industry.name}</span>
            {industry.avgShortPercent > 0 && (
              <span className="text-muted-foreground">
                {industry.avgShortPercent.toFixed(1)}%
              </span>
            )}
          </Link>
        ))}
      </div>
    </section>
  );
}
