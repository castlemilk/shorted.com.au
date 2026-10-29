import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { siteConfig } from "~/@/config/site";
import { formatCompanyName } from "~/@/lib/company-name";
import { CHART_PERIOD_PHRASE } from "~/@/components/charts/chart-views";
import {
  CHART_SOURCE,
  chartImageUrl,
  chartShareUrl,
  chartSubject,
} from "~/@/lib/embed/snippet";
import { getStock } from "~/app/actions/getStock";
import { isChartCode, parseChartShareParams } from "~/app/embed/chart/params";
import { ChartShareView } from "./chart-share-view";

interface PageProps {
  params: Promise<{ code: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/**
 * Not indexed: the page is one chart, and the stock page it links to is the
 * one that should rank. Followed, so a link shared on a forum still reaches
 * /shorts/<code>. NOT disallowed in robots.txt (unlike /embed/), because
 * Twitterbot and Slackbot honour robots.txt and would not unfurl the link.
 */
const NOINDEX = {
  index: false,
  follow: true,
  googleBot: { index: false, follow: true },
} as const;

async function readCompany(code: string): Promise<string | null> {
  try {
    const stock = await getStock(code);
    return stock ? formatCompanyName(stock.name ?? "", code) || null : null;
  } catch {
    return null; // the card and the page work without it
  }
}

export async function generateMetadata({
  params,
  searchParams,
}: PageProps): Promise<Metadata> {
  const { code: rawCode } = await params;
  if (!isChartCode(rawCode)) return { robots: NOINDEX };
  const { code, view, period } = parseChartShareParams(
    rawCode,
    await searchParams,
  );
  const company = await readCompany(code);
  const subject = chartSubject(view);
  const when = CHART_PERIOD_PHRASE[period];
  const title = `${code} ${subject} chart, ${when}`;
  const description = `Interactive chart of ${company ? `${company} (ASX:${code})` : `ASX:${code}`} ${subject}, ${when}, from ${CHART_SOURCE[view]}. Updated daily.`;
  const url = chartShareUrl(code, view, period);
  const image = {
    url: chartImageUrl(code, view, period),
    width: 1200,
    height: 630,
    alt: `${code} ${subject} chart, ${when}`,
  };
  return {
    title,
    description,
    robots: NOINDEX,
    openGraph: {
      title: `${title} | ${siteConfig.name}`,
      description,
      url,
      siteName: siteConfig.name,
      type: "website",
      locale: "en_AU",
      images: [image],
    },
    // Next merges `twitter` shallowly, so site and creator are repeated here.
    twitter: {
      card: "summary_large_image",
      site: siteConfig.twitterHandle,
      creator: siteConfig.twitterHandle,
      title: `${title} | ${siteConfig.name}`,
      description,
      images: [image],
    },
  };
}

/**
 * The chart share page, `/chart/WBT?view=combined&period=1m`: what the share
 * dialog's link opens. A full-screen chart (with a landscape mode for phones)
 * under a slim bar back to the stock page. Its card is the chart itself
 * (./image), so a link pasted into Discord or Slack shows the chart.
 * `?landscape=1` opens it turned sideways on a phone held upright.
 */
export default async function ChartSharePage({
  params,
  searchParams,
}: PageProps) {
  const { code: rawCode } = await params;
  if (!isChartCode(rawCode)) notFound();
  const query = await searchParams;
  const { code, view, period } = parseChartShareParams(rawCode, query);
  const company = await readCompany(code);
  return (
    <ChartShareView
      code={code}
      view={view}
      period={period}
      company={company}
      // The bot's "Open on Shorted" link (lib/discord/messages.ts).
      startLandscape={query.landscape === "1"}
    />
  );
}
