import { type Metadata } from "next";
import dynamic from "next/dynamic";
import { siteConfig } from "~/@/config/site";
import { BreadcrumbListSchema } from "~/@/components/seo/enhanced-structured-data";
import { BattlegroundView } from "~/gen/shorts/v1alpha1/shorts_pb";
import { getBattlegrounds } from "~/app/actions/getBattlegrounds";
import { toBattlegroundRows } from "./types";

const BattlegroundsClient = dynamic(
  () =>
    import("./battlegrounds-client").then((mod) => mod.BattlegroundsClient),
  {
    loading: () => <BattlegroundsSkeleton />,
    ssr: true,
  },
);

const TITLE = "Battleground Stocks — Bulls vs Short Sellers | Shorted";
const DESCRIPTION =
  "Squeeze radar and battleground stocks on the ASX: stocks ranked by short squeeze risk, and live bull-vs-bear conflicts where prices rise while short sellers keep building. Official ASIC data, updated daily.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    url: `${siteConfig.url}/battlegrounds`,
    siteName: siteConfig.name,
    type: "website",
    locale: "en_AU",
    images: [
      {
        url: siteConfig.ogImage,
        width: 1200,
        height: 630,
        alt: "Battleground Stocks — Shorted.com.au",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: TITLE,
    description: DESCRIPTION,
    images: [siteConfig.ogImage],
  },
  alternates: {
    canonical: `${siteConfig.url}/battlegrounds`,
    languages: {
      "en-AU": `${siteConfig.url}/battlegrounds`,
      "x-default": `${siteConfig.url}/battlegrounds`,
    },
  },
};

function BattlegroundsSkeleton() {
  return (
    <div className="space-y-4">
      <div className="h-9 w-64 bg-muted animate-pulse rounded-lg" />
      <div className="h-4 w-96 bg-muted animate-pulse rounded" />
      <div className="border rounded-lg">
        <div className="h-12 bg-muted/50 border-b" />
        {Array.from({ length: 10 }).map((_, i) => (
          <div
            key={i}
            className="h-12 border-b last:border-b-0 flex items-center px-4"
          >
            <div className="h-4 w-full bg-muted animate-pulse rounded" />
          </div>
        ))}
      </div>
    </div>
  );
}

const breadcrumbs = [
  { name: "Home", url: siteConfig.url },
  { name: "Battleground Stocks", url: `${siteConfig.url}/battlegrounds` },
];

export default async function BattlegroundsPage() {
  // SSR-fetch the default squeeze view; on failure the client refetches
  const initial = await getBattlegrounds(BattlegroundView.SQUEEZE, 25, 0);

  return (
    <main className="min-h-[calc(100vh-4rem)]">
      <BreadcrumbListSchema items={breadcrumbs} />
      <div className="container mx-auto px-4 py-6 max-w-7xl space-y-6">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold tracking-tight">
            Battleground Stocks
          </h1>
          <p className="text-muted-foreground mt-2 max-w-2xl text-sm leading-relaxed">
            Where bulls and short sellers collide. The squeeze radar ranks ASX
            stocks by short squeeze risk — days-to-cover, short interest,
            crowding, and price momentum — while the battlegrounds view surfaces
            live divergences where the price is rising even as shorts keep
            building. Sourced from official ASIC short position reports, updated
            daily with a T+4 trading day delay.
          </p>
        </div>
        <BattlegroundsClient
          initialRows={initial ? toBattlegroundRows(initial.stocks) : undefined}
          initialTotalCount={initial?.totalCount}
        />
      </div>
    </main>
  );
}
