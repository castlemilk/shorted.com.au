import { type Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { sectionTitle } from "~/@/lib/typography";
import { siteConfig } from "~/@/config/site";
import { BreadcrumbListSchema } from "~/@/components/seo/enhanced-structured-data";
import { getStrategy } from "~/@/lib/strategies/registry";
import { buildRuleParamRows } from "~/@/lib/strategies/rules-view";
import { formatIsoDate, firstNonEmpty } from "~/@/lib/strategies/format";
import { shortRulesHash, versionFullText } from "~/@/lib/strategies/versions";
import type {
  StrategyRuleDef,
  StrategyVersionDetailView,
} from "~/@/lib/strategies/types";
import { getStrategies } from "~/app/actions/getStrategies";
import { getStrategyVersion } from "~/app/actions/strategies/getStrategyVersion";
import { listStrategyVersions } from "~/app/actions/strategies/listStrategyVersions";
import { bailOnEmptyRender } from "~/app/actions/config";

// The Rules tab: the numbers the live rules version tests each stock with. The
// author's rule wording stays on the Overview and is not repeated here; this
// page states the parameters, the score weights and roles, the data and
// universe policy, and this strategy's changelog.
//
// Static ISR like the other tabs, one cached read per source per hour. No
// searchParams or cookies are read, so the route stays prerendered.
export const revalidate = 3600;
export const maxDuration = 60;

interface PageProps {
  params: Promise<{ strategy: string }>;
}

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const { strategy: slug } = await params;
  const seo = getStrategy(slug);
  if (!seo) notFound();
  const url = `${siteConfig.url}/strategies/${seo.slug}/rules`;
  const title = `Rules: ${seo.h1}`;
  const description = `The thresholds, score weights, data and universe policy and changelog behind the ${seo.h1}, as its live rules version tests them.`;
  // A nested page that sets openGraph replaces the inherited image, so the
  // strategy's own card is named explicitly, as the Signals tab does.
  const image = {
    url: `/strategies/${seo.slug}/opengraph-image`,
    width: 1200,
    height: 630,
    alt: `${seo.h1} rules, on Shorted`,
  };
  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: {
      title: `${title} | ${siteConfig.name}`,
      description,
      url,
      siteName: siteConfig.name,
      type: "website",
      locale: "en_AU",
      images: [image],
    },
    twitter: {
      site: "@shorted___",
      creator: "@shorted___",
      card: "summary_large_image",
      title,
      description,
      images: [image.url],
    },
  };
}

export default async function StrategyRulesPage({ params }: PageProps) {
  const { strategy: slug } = await params;
  const seo = getStrategy(slug);
  if (!seo) notFound();

  const [catalogue, live, history] = await Promise.all([
    getStrategies(),
    getStrategyVersion(seo.slug),
    listStrategyVersions(),
  ]);
  // A failed read must not bake a degraded page into the route cache.
  if (!catalogue || !live || !history) await bailOnEmptyRender();

  const definition =
    catalogue?.strategies.find((strategy) => strategy.id === seo.slug) ?? null;
  const strategyName = firstNonEmpty(definition?.name, seo.h1);
  const pageUrl = `${siteConfig.url}/strategies/${seo.slug}/rules`;
  const breadcrumbs = [
    { name: "Home", url: siteConfig.url },
    { name: "Strategies", url: `${siteConfig.url}/strategies` },
    { name: seo.h1, url: `${siteConfig.url}/strategies/${seo.slug}` },
    { name: "Rules", url: pageUrl },
  ];

  return (
    <>
      <BreadcrumbListSchema items={breadcrumbs} />
      {live ? (
        <RulesBody
          strategyName={strategyName}
          live={live}
          rules={definition?.rules ?? []}
          changelog={(history ?? []).filter(
            (entry) => entry.version.strategyId === seo.slug,
          )}
          changelogAvailable={history !== null}
        />
      ) : (
        <section className="rounded-lg border border-border/60 bg-card p-6 text-sm text-muted-foreground">
          The rules for this strategy are temporarily unavailable; they refresh
          automatically. Not financial advice.
        </section>
      )}
    </>
  );
}

interface RulesBodyProps {
  strategyName: string;
  live: StrategyVersionDetailView;
  rules: readonly StrategyRuleDef[];
  changelog: StrategyVersionDetailView[];
  changelogAvailable: boolean;
}

function RulesBody({
  strategyName,
  live,
  rules,
  changelog,
  changelogAvailable,
}: RulesBodyProps) {
  const version = live.version;
  const liveFrom = formatIsoDate(version.liveFrom);
  const rows = buildRuleParamRows(rules, live.params);

  return (
    <div className="space-y-10">
      <p className="max-w-3xl text-muted-foreground">
        The live rules version of the {strategyName}, as it is tested against
        each stock. The rule wording is on the Overview. Weights are each
        rule&rsquo;s share of the score, and a rule shown as Off is switched
        off.
      </p>

      <section aria-labelledby="rules-version" className="space-y-3">
        <h2 id="rules-version" className={sectionTitle}>
          Version
        </h2>
        <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[max-content_1fr]">
          <dt className="text-muted-foreground">Rules</dt>
          <dd className="font-mono tabular-nums">
            {versionFullText(version)}
          </dd>
          <dt className="text-muted-foreground">Rules hash</dt>
          <dd className="break-all font-mono text-xs">{version.rulesHash}</dd>
          {liveFrom ? (
            <>
              <dt className="text-muted-foreground">Live from</dt>
              <dd>{liveFrom}</dd>
            </>
          ) : null}
          {version.featureSet ? (
            <>
              <dt className="text-muted-foreground">Feature set</dt>
              <dd className="font-mono">{version.featureSet}</dd>
            </>
          ) : null}
        </dl>
        {version.rulesHash ? (
          <p className="text-sm">
            <Link
              href={`/strategies/changelog#${version.rulesHash}`}
              prefetch={false}
              className="text-primary hover:underline"
            >
              This version in the changelog
            </Link>
          </p>
        ) : null}
      </section>

      <section aria-labelledby="rules-parameters" className="space-y-3">
        <h2 id="rules-parameters" className={sectionTitle}>
          Parameters
        </h2>
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            This version names no rules.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[520px] border-collapse text-sm">
              <caption className="sr-only">
                Each rule of the {strategyName}, its role, its weight and the
                numbers it tests
              </caption>
              <thead>
                <tr className="border-b border-border/60 text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th scope="col" className="py-2 pr-4 font-medium">
                    Rule
                  </th>
                  <th scope="col" className="py-2 pr-4 font-medium">
                    Role
                  </th>
                  <th scope="col" className="py-2 pr-4 font-medium">
                    Weight
                  </th>
                  <th scope="col" className="py-2 font-medium">
                    Parameters
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr
                    key={row.ruleId}
                    className="border-b border-border/40 align-top"
                  >
                    <th scope="row" className="py-2 pr-4 text-left font-medium">
                      {row.title}
                    </th>
                    <td className="py-2 pr-4 text-muted-foreground">
                      {row.roles.join(" · ") || "n/a"}
                    </td>
                    <td className="py-2 pr-4 font-mono tabular-nums">
                      {row.weight || "n/a"}
                    </td>
                    <td className="py-2">
                      {row.params.length === 0 ? (
                        <span className="text-muted-foreground">
                          No numeric parameter
                        </span>
                      ) : (
                        <ul className="space-y-1">
                          {row.params.map((line) => (
                            <li
                              key={`${row.ruleId}-${line.name}`}
                              className="font-mono text-xs"
                            >
                              {line.name} = {line.value}
                            </li>
                          ))}
                        </ul>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {live.policies.length > 0 ? (
        <section aria-labelledby="rules-policy" className="space-y-3">
          <h2 id="rules-policy" className={sectionTitle}>
            Universe and data policy
          </h2>
          <ul className="list-disc space-y-1 pl-5 text-sm">
            {live.policies.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </section>
      ) : null}

      <section aria-labelledby="rules-changelog" className="space-y-4">
        <h2 id="rules-changelog" className={sectionTitle}>
          Changelog
        </h2>
        {!changelogAvailable ? (
          <p className="text-sm text-muted-foreground">
            The changelog is unavailable right now. Try again shortly.
          </p>
        ) : changelog.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No published versions of this strategy yet.
          </p>
        ) : (
          changelog.map((entry) => (
            <article
              key={entry.version.rulesHash}
              id={entry.version.rulesHash}
              className="scroll-mt-24 space-y-3 rounded-md border border-border/60 bg-card p-4 sm:p-6"
            >
              <header className="space-y-1">
                <h3 className="text-base font-semibold">
                  {entry.version.label}
                  {entry.version.status === "live" ? (
                    <span className="ml-2 align-middle text-xs font-normal uppercase tracking-wide text-muted-foreground">
                      Live
                    </span>
                  ) : null}
                </h3>
                <p className="font-mono text-xs text-muted-foreground">
                  {shortRulesHash(entry.version.rulesHash)}
                  {entry.supersededOn
                    ? ` · superseded ${formatIsoDate(entry.supersededOn)}`
                    : ""}
                </p>
              </header>
              {entry.changes.length > 0 ? (
                <div className="space-y-1">
                  <h4 className="text-sm font-medium">What changed</h4>
                  <ul className="list-disc space-y-1 pl-5 text-sm">
                    {entry.changes.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {entry.knownIssues.length > 0 ? (
                <div className="space-y-1">
                  <h4 className="text-sm font-medium">Known issues</h4>
                  <ul className="list-disc space-y-1 pl-5 text-sm">
                    {entry.knownIssues.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </article>
          ))
        )}
        <p className="text-sm">
          <Link
            href="/strategies/changelog"
            prefetch={false}
            className="text-primary hover:underline"
          >
            Every strategy&rsquo;s changelog
          </Link>
        </p>
      </section>

      <p className="text-xs text-muted-foreground">Not financial advice.</p>
    </div>
  );
}
