import { type Metadata } from "next";
import Link from "next/link";

import { cn } from "~/@/lib/utils";
import { eyebrow, lede, pageTitle, sectionTitle } from "~/@/lib/typography";
import { siteConfig } from "~/@/config/site";
import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";
import { Breadcrumbs } from "~/@/components/seo/breadcrumbs";
import { BreadcrumbListSchema } from "~/@/components/seo/enhanced-structured-data";
import { STRATEGIES, STRATEGY_SLUGS } from "~/@/lib/strategies/registry";
import { versionFullText } from "~/@/lib/strategies/versions";
import type { StrategyVersionDetailView } from "~/@/lib/strategies/types";
import { listStrategyVersions } from "~/app/actions/strategies/listStrategyVersions";
import { bailOnEmptyRender } from "~/app/actions/config";

const TITLE = "Strategy Rules Changelog";
const DESCRIPTION =
  "Every published version of the ASX stock picker's rules: its rules hash, the engine it runs on, what changed, and the defects it is known to have.";
const PAGE_URL = `${siteConfig.url}/strategies/changelog`;

export const metadata: Metadata = {
  // The root layout's title template adds the brand; openGraph has none.
  title: TITLE,
  description: DESCRIPTION,
  openGraph: {
    title: `${TITLE} | ${siteConfig.name}`,
    description: DESCRIPTION,
    url: PAGE_URL,
    siteName: siteConfig.name,
    type: "website",
    locale: "en_AU",
  },
  alternates: {
    canonical: PAGE_URL,
    languages: { "en-AU": PAGE_URL, "x-default": PAGE_URL },
  },
};

// Static ISR, like /strategies: the versions change only with a deploy, so an
// hour is plenty. A failed read is handled by bailOnEmptyRender() below.
export const revalidate = 3600;

const breadcrumbs = [
  { name: "Home", url: siteConfig.url },
  { name: "Strategies", url: `${siteConfig.url}/strategies` },
  { name: TITLE, url: PAGE_URL },
];

/** Versions grouped by strategy, in the registry's strategy order. */
function groupByStrategy(
  versions: readonly StrategyVersionDetailView[],
): Array<{ slug: string; versions: StrategyVersionDetailView[] }> {
  return STRATEGY_SLUGS.map((slug) => ({
    slug,
    versions: versions.filter((v) => v.version.strategyId === slug),
  })).filter((group) => group.versions.length > 0);
}

export default async function StrategyChangelogPage() {
  const versions = await listStrategyVersions();
  // A failed read would bake the empty notice into the route cache for the
  // whole hour: shorten this render's lifetime instead.
  if (!versions) await bailOnEmptyRender();
  const groups = groupByStrategy(versions ?? []);

  return (
    <DashboardLayout>
      <BreadcrumbListSchema items={breadcrumbs} />
      <div className="space-y-8">
        <div className="mb-4">
          <Breadcrumbs
            items={[
              { label: "Strategies", href: "/strategies" },
              { label: TITLE, href: "/strategies/changelog" },
            ]}
          />
        </div>

        <section className="border-b border-border/40 pb-6">
          <p className={cn(eyebrow, "mb-2 font-medium")}>Stock picker</p>
          <h1 className={cn(pageTitle, "leading-[1.1]")}>{TITLE}</h1>
          <p className={cn(lede, "max-w-3xl")}>
            Each strategy&rsquo;s rules are published as a version, identified
            by a hash of its exact parameters. Picks and stock fits name the
            version they were evaluated under. Each version keeps the known
            issues it shipped with.
          </p>
        </section>

        {groups.length === 0 ? (
          <p className="text-muted-foreground">
            The rules changelog is unavailable right now. Try again shortly.
          </p>
        ) : (
          groups.map(({ slug, versions: list }) => (
            <section
              key={slug}
              aria-labelledby={`changelog-${slug}`}
              className="space-y-6"
            >
              <h2 id={`changelog-${slug}`} className={sectionTitle}>
                <Link
                  href={`/strategies/${slug}`}
                  prefetch={false}
                  className="hover:underline"
                >
                  {STRATEGIES[slug]?.h1 ?? slug}
                </Link>
              </h2>
              {list.map((entry) => (
                <article
                  key={entry.version.rulesHash}
                  id={entry.version.rulesHash}
                  className="scroll-mt-[124px] space-y-4 rounded-md border border-border/60 bg-card p-4 sm:p-6"
                >
                  <header className="space-y-1">
                    <h3 className="text-lg font-semibold">
                      {entry.version.label}
                      {entry.version.status === "live" ? (
                        <span className="ml-2 align-middle text-xs font-normal uppercase tracking-wide text-muted-foreground">
                          Live
                        </span>
                      ) : null}
                    </h3>
                    <p className="font-mono text-xs text-muted-foreground break-all">
                      rules_hash {entry.version.rulesHash}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {versionFullText(entry.version)} · feature set{" "}
                      {entry.version.featureSet || "unknown"}
                    </p>
                  </header>

                  {entry.changes.length > 0 ? (
                    <div className="space-y-2">
                      <h4 className="font-medium">What changed</h4>
                      <ul className="list-disc space-y-1 pl-5 text-sm">
                        {entry.changes.map((line) => (
                          <li key={line}>{line}</li>
                        ))}
                      </ul>
                    </div>
                  ) : null}

                  {entry.knownIssues.length > 0 ? (
                    <div className="space-y-2">
                      <h4 className="font-medium">Known issues</h4>
                      <ul className="list-disc space-y-1 pl-5 text-sm">
                        {entry.knownIssues.map((line) => (
                          <li key={line}>{line}</li>
                        ))}
                      </ul>
                    </div>
                  ) : null}

                  {entry.policies.length > 0 ? (
                    <div className="space-y-2">
                      <h4 className="font-medium">Universe and data policy</h4>
                      <ul className="list-disc space-y-1 pl-5 text-sm">
                        {entry.policies.map((line) => (
                          <li key={line}>{line}</li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                </article>
              ))}
            </section>
          ))
        )}
      </div>
    </DashboardLayout>
  );
}
