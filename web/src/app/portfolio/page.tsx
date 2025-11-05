import { type Metadata } from "next";
import { Suspense } from "react";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { Loader2 } from "lucide-react";
import { DashboardLayout } from "@/components/layouts/dashboard-layout";
import { PortfolioClient } from "./components/portfolio-client";
import { getPortfolioData } from "../actions/getPortfolio";

// ISR: Revalidate portfolio data every 5 minutes
export const revalidate = 300;

// Metadata for SEO
export const metadata: Metadata = {
  title: "My Portfolio | Shorted",
  description:
    "Track your ASX stock holdings and performance. Monitor portfolio value, gains, losses, and analyze your best and worst performing stocks in real-time.",
  keywords: [
    "portfolio tracker",
    "stock portfolio",
    "ASX portfolio",
    "investment tracking",
    "portfolio management",
    "stock performance",
    "portfolio analysis",
  ],
  openGraph: {
    title: "Portfolio Tracker | Shorted",
    description:
      "Track your ASX stock portfolio with real-time valuations and performance analytics.",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "My Portfolio | Shorted",
    description:
      "Monitor your ASX stock holdings with real-time market data and performance tracking.",
  },
};

function PortfolioLoadingState() {
  return (
    <div className="flex items-center justify-center h-64">
      <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
    </div>
  );
}

export default async function PortfolioPage() {
  // Check authentication on server
  const session = await auth();

  if (!session) {
    // Redirect to sign-in if not authenticated
    redirect("/signin?callbackUrl=/portfolio");
  }

  // Fetch initial portfolio data on server
  const portfolioData = await getPortfolioData();

  return (
    <DashboardLayout>
      <Suspense fallback={<PortfolioLoadingState />}>
        <PortfolioClient initialHoldings={portfolioData?.holdings ?? []} />
      </Suspense>
    </DashboardLayout>
  );
}
