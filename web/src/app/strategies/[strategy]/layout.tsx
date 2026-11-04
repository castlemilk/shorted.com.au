import { notFound } from "next/navigation";

import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";
import { Breadcrumbs } from "~/@/components/seo/breadcrumbs";
import { StrategyHeader } from "~/@/components/strategies/strategy-header";
import { StrategyTabNav } from "~/@/components/strategies/strategy-tab-nav";
import { STRATEGY_SLUGS, getStrategy } from "~/@/lib/strategies/registry";

// The profile's chrome: the breadcrumbs, the faceplate, the tab bar, then the
// tab. It reads nothing (no data, no cookies, no searchParams), so it cannot
// fail a render or make the segment dynamic. Each tab page below exports its
// own revalidate.
//
// The layout owns the static params. dynamicParams = false makes an unknown
// slug a routing 404 before any loading.tsx streams, so the status code is 404.
export const dynamicParams = false;

export function generateStaticParams() {
  return STRATEGY_SLUGS.map((strategy) => ({ strategy }));
}

interface LayoutProps {
  children: React.ReactNode;
  params: Promise<{ strategy: string }>;
}

export default async function StrategyLayout({
  children,
  params,
}: LayoutProps) {
  const { strategy: slug } = await params;
  const seo = getStrategy(slug);
  if (!seo) notFound();

  return (
    <DashboardLayout>
      <div className="mb-4">
        <Breadcrumbs
          prefetch={false}
          items={[
            { label: "Strategies", href: "/strategies" },
            { label: seo.h1, href: `/strategies/${seo.slug}` },
          ]}
        />
      </div>

      <StrategyHeader slug={seo.slug} />

      <StrategyTabNav slug={seo.slug} />

      {children}
    </DashboardLayout>
  );
}
