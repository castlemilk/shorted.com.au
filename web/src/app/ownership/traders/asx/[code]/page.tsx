import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cache } from "react";
import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";
import {
  DirectorRecords,
  type DirectorRecord,
} from "~/@/components/ownership/traders/director-records";
import { Breadcrumbs } from "~/@/components/seo/breadcrumbs";
import { graphHref } from "~/@/lib/ownership/graph-links";
import { registerHref } from "~/@/lib/ownership/kinds";
import {
  ASX_CODE,
  DIRECTOR_READ_LIMIT,
  directorHref,
  isNamedDirectorTrade,
  TRADERS_PATH,
} from "~/@/lib/ownership/traders";
import { safeExternalHref } from "~/@/lib/safe-external-href";
import { lede, pageTitle } from "~/@/lib/typography";
import { getDirectorTrades } from "~/app/actions/getDirectorTrades";
import { getStockOrNotFound } from "~/app/actions/getStock";
import { NotFoundError } from "~/app/actions/withRetry";

export const revalidate = 3600;
export const dynamicParams = true;
export function generateStaticParams(): Array<{ code: string }> {
  return [];
}

type Props = { params: Promise<{ code: string }> };

const read = cache(async (code: string) => {
  if (!ASX_CODE.test(code)) notFound();
  const trades = await getDirectorTrades(code, DIRECTOR_READ_LIMIT);
  if (!trades) throw new Error(`Director filings unavailable for ${code}`);
  // A recorded filing establishes the issuer even when it has no ASIC short series.
  if (!trades.trades.length) {
    try {
      if (!(await getStockOrNotFound(code)))
        throw new Error(`Company lookup unavailable for ${code}`);
    } catch (error) {
      if (error instanceof NotFoundError) notFound();
      throw error;
    }
  }
  return trades.trades;
});

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const code = (await params).code.toUpperCase();
  const trades = await read(code);
  return {
    title: `${code} director disclosures by name`,
    description: `Browse director interest changes for ASX:${code} and open the original company filings.`,
    alternates: { canonical: `https://shorted.com.au${directorHref(code)}` },
    ...(trades.some(isNamedDirectorTrade)
      ? {}
      : { robots: { index: false, follow: true } }),
  };
}

const price = new Intl.NumberFormat("en-AU", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});
const value = new Intl.NumberFormat("en-AU", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const types: Record<string, string> = {
  buy: "Acquisition",
  sell: "Disposal",
  exercise_options: "Option exercise",
};

export default async function AsxDirectorsPage({ params }: Props) {
  const raw = (await params).code;
  const code = raw.toUpperCase();
  if (!ASX_CODE.test(code)) notFound();
  const trades = await read(code);
  const rows: DirectorRecord[] = trades
    .filter(isNamedDirectorTrade)
    .map((t) => ({
      id: t.id,
      director: t.directorName.trim(),
      date: t.tradeDate.slice(0, 10),
      type: types[t.tradeType] ?? "Other change",
      units: t.sharesTraded.toLocaleString("en-AU"),
      price: t.pricePerShare > 0 ? price.format(t.pricePerShare) : "n/a",
      value: t.totalValue > 0 ? value.format(t.totalValue) : "n/a",
      source: safeExternalHref(t.announcementUrl),
    }));
  const crumbs = [
    { label: "Ownership", href: "/ownership" },
    { label: "Traders", href: TRADERS_PATH },
    { label: code, href: directorHref(code) },
  ];
  return (
    <DashboardLayout>
      <div className="mx-auto max-w-6xl space-y-7">
        <Breadcrumbs items={crumbs} prefetch={false} />
        <header>
          <h1 className={pageTitle}>{code} director disclosures</h1>
          <p className={lede}>
            Changes in directors’ interests reported by ASX:{code}. Interests
            may be held directly or through another entity.
          </p>
        </header>
        <div className="flex flex-wrap items-baseline justify-between gap-3 border-y py-3 text-sm">
          <p>
            {trades.length === DIRECTOR_READ_LIMIT
              ? `Latest ${DIRECTOR_READ_LIMIT} company records reviewed`
              : `${trades.length} company record${trades.length === 1 ? "" : "s"} reviewed`}
            . Only named changes with a reported quantity are shown.
          </p>
          <Link
            prefetch={false}
            href={graphHref("company", code)}
            className="text-primary underline-offset-4 hover:underline"
          >
            Explore {code} ownership graph →
          </Link>
          <Link
            prefetch={false}
            href={registerHref(code)}
            className="text-primary underline-offset-4 hover:underline"
          >
            Company ownership register →
          </Link>
        </div>
        <DirectorRecords code={code} rows={rows} />
      </div>
    </DashboardLayout>
  );
}
