import { type Metadata } from "next";
import Link from "next/link";

import {
  Breadcrumbs,
  BreadcrumbStructuredData,
} from "~/@/components/seo/breadcrumbs";
import { siteConfig } from "~/@/config/site";
import { eyebrow, lede, pageTitle, sectionTitle } from "~/@/lib/typography";
import { STEERED_CRAWLERS } from "~/@/lib/seo/crawl-policy";

export const revalidate = 86400;

const PATH = "/docs/data-licence";
const URL = `${siteConfig.url}${PATH}`;
const TITLE = "Data licence and bulk access";
const DESCRIPTION =
  "How to use Shorted's ASX short position, ownership, housing and economy data at volume: the API, the MCP server, the open data downloads, and the crawl policy that sends scrapers here.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: URL },
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    url: URL,
    siteName: siteConfig.name,
    type: "article",
    locale: "en_AU",
  },
};

/** The ways in, each with the page that explains it. */
const ROUTES_IN = [
  {
    title: "The API",
    href: "/docs/api",
    body: "Every dataset on the site, as JSON over HTTPS, with a key. Free keys have a monthly quota; paid plans raise it. Rate limits and quotas are published on the docs and enforced as published.",
  },
  {
    title: "The MCP server",
    href: "/docs/mcp.md",
    body: "The same data as tools for Claude, ChatGPT and any Model Context Protocol client. Add the URL and the client does the rest: no key to paste, and signing in raises the limits.",
  },
  {
    title: "Open data",
    href: "/data",
    body: "Bulk downloads of the ASIC short position series and the other public datasets, with their sources, update cadence and attribution line.",
  },
  {
    title: "The feed",
    href: "/feed.xml",
    body: "RSS for the reports, the blog and the news desk, so a reader does not need to poll pages.",
  },
];

/**
 * The page a steered crawler is sent to, and the page robots.txt points at
 * for bulk access. It says what the data is, how to get it without crawling,
 * and what the crawl policy is, so a crawler operator who lands here knows
 * what to do next. The steered list is the route's own, so the page cannot
 * name an agent robots.txt does not steer.
 */
export default function DataLicencePage() {
  const crumbs = [{ label: "Data licence", href: PATH }];
  return (
    <main className="min-h-screen">
      <BreadcrumbStructuredData items={crumbs} />
      <div className="container mx-auto max-w-3xl px-4 py-8">
        <div className="mb-6">
          <Breadcrumbs items={crumbs} />
        </div>

        <article className="prose prose-neutral max-w-none dark:prose-invert">
          <p className={eyebrow}>Documentation</p>
          <h1 className={pageTitle}>{TITLE}</h1>
          <p className={lede}>
            Shorted publishes official ASIC short position data for every ASX
            stock, who holds those stocks, Australian house prices and economic
            series. All of it is available at volume without crawling the site.
          </p>

          <section aria-labelledby="why" className="not-prose mt-8">
            <h2 id="why" className={sectionTitle}>
              If a crawler sent you here
            </h2>
            <p className="mt-3 text-muted-foreground">
              Your user agent is on the list below. Those agents are redirected
              to this page at the edge and asked not to crawl in robots.txt,
              because they either serve no readers of this site or were measured
              fetching the same pages thousands of times a day. Nothing else on
              the site answers them.
            </p>
            <ul className="mt-3 flex flex-wrap gap-2 font-mono text-xs">
              {STEERED_CRAWLERS.map((agent) => (
                <li
                  key={agent}
                  className="rounded-md border border-border/60 px-2 py-1 text-muted-foreground"
                >
                  {agent}
                </li>
              ))}
            </ul>
            <p className="mt-3 text-muted-foreground">
              If you operate one of them and want the data, use a route below.
              If you think the listing is a mistake, write to{" "}
              <a
                href={`mailto:${siteConfig.contact.email}`}
                className="underline underline-offset-4 hover:text-foreground"
              >
                {siteConfig.contact.email}
              </a>{" "}
              with the agent name and what it is for.
            </p>
          </section>

          <section aria-labelledby="routes" className="not-prose mt-8">
            <h2 id="routes" className={sectionTitle}>
              Getting the data
            </h2>
            <ul className="mt-4 space-y-4">
              {ROUTES_IN.map((route) => (
                <li key={route.href}>
                  <Link
                    href={route.href}
                    prefetch={false}
                    className="font-medium underline underline-offset-4 hover:text-primary"
                  >
                    {route.title}
                  </Link>
                  <p className="mt-1 text-sm text-muted-foreground">{route.body}</p>
                </li>
              ))}
            </ul>
          </section>

          <section aria-labelledby="licence" className="not-prose mt-8">
            <h2 id="licence" className={sectionTitle}>
              Licence
            </h2>
            <p className="mt-3 text-muted-foreground">
              The underlying figures come from public sources: ASIC short
              position reports, ASX announcements, ABS and RBA statistics, state
              valuer-general sales and the federal registers of interests. Each
              dataset names its source and its update cadence on the open data
              page. What Shorted adds (the enrichment, the derived series, the
              reports and the editorial) is published under the{" "}
              <Link href="/terms" prefetch={false} className="underline underline-offset-4">
                terms of use
              </Link>
              . Reuse of the data needs attribution to Shorted.com.au and the
              original source; the open data page gives the line to use.
            </p>
            <p className="mt-3 text-muted-foreground">
              AI systems may read and cite the public pages: the robots.txt
              Content-Signal says so, and the crawl rules name the sections they
              may read and ask for a five second delay between fetches. Training
              on the site and bulk extraction go through the API or the open
              data downloads, not the HTML.
            </p>
          </section>

          <section aria-labelledby="policy" className="not-prose mt-8">
            <h2 id="policy" className={sectionTitle}>
              Crawl policy
            </h2>
            <ul className="mt-3 list-disc space-y-2 pl-5 text-muted-foreground">
              <li>
                Search engines may crawl every public page. The RPC endpoints,
                the private pages and the parameterised views are disallowed
                because nothing there can be indexed.
              </li>
              <li>
                AI crawlers may read the listed content sections with a
                Crawl-delay of five seconds. Verified AI crawlers are also rate
                limited at the edge, per address.
              </li>
              <li>
                The agents named above are steered here. A crawler that ignores
                robots.txt is redirected before it reaches the site.
              </li>
              <li>
                The machine-readable statements are{" "}
                <a href="/robots.txt" className="underline underline-offset-4">
                  robots.txt
                </a>
                ,{" "}
                <a href="/ai.txt" className="underline underline-offset-4">
                  ai.txt
                </a>{" "}
                and{" "}
                <a href="/llms.txt" className="underline underline-offset-4">
                  llms.txt
                </a>
                .
              </li>
            </ul>
          </section>
        </article>
      </div>
    </main>
  );
}
