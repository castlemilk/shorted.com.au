import { type Metadata } from "next";
import { notFound } from "next/navigation";
import { BreadcrumbStructuredData } from "~/@/components/seo/breadcrumbs";
import { CommunityTab } from "~/@/components/company/community/community-tab";
import { stockTabMetadata } from "~/@/lib/seo/stock-tab-metadata";
import { stockTabHref, stockTabLabel } from "~/@/lib/stocks/stock-tabs";
import { STOCK_CODE_PATTERN } from "../stock-page-shared";

// The list is client-fetched (volatile, session-aware), so the page is a
// static shell: no stock read of its own (the layout already validated the
// code against the API) and noindex (the thread pages beneath carry the
// crawlable text).
export const revalidate = 3600;
export const dynamicParams = true;
export function generateStaticParams(): Array<{ stockCode: string }> {
  return [];
}

interface PageProps {
  params: Promise<{ stockCode: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const code = (await params).stockCode.toUpperCase();
  return stockTabMetadata({
    code,
    tab: "community",
    title: (company) => `${code} Community Discussion | ${company}`,
    description: (company) => `Research threads and pulse on ${company} (ASX:${code}) from the Shorted community.`,
    forceNoindex: true,
  });
}

export default async function CommunityPage({ params }: PageProps) {
  const code = (await params).stockCode.toUpperCase();
  if (!STOCK_CODE_PATTERN.test(code)) notFound();
  return (
    <>
      <BreadcrumbStructuredData
        items={[
          { label: "Stocks", href: "/stocks" },
          { label: code, href: stockTabHref(code, "overview") },
          { label: stockTabLabel("community"), href: stockTabHref(code, "community") },
        ]}
      />
      {/* The island's lists print their own titles (Research Threads, Live
          Pulse), so the page adds only the h1, and keeps it out of sight. */}
      <h1 className="sr-only">{code} community</h1>
      <CommunityTab stockCode={code} />
    </>
  );
}
