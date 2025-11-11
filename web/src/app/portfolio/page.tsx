"use client";

import { useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";
import { PortfolioClient } from "./components/portfolio-client";
import { getPortfolioData } from "../actions/getPortfolio";
import { type PortfolioHolding } from "~/@/lib/portfolio-service";

function PortfolioLoadingState() {
  return (
    <div className="flex items-center justify-center h-64">
      <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
    </div>
  );
}

export default function PortfolioPage() {
  const { data: session, status } = useSession();
  const router = useRouter();
  const [holdings, setHoldings] = useState<PortfolioHolding[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Note: This route is protected by middleware, so if we reach here, user is authenticated
    // Wait for session to hydrate from server before fetching portfolio data
    if (status === "loading" || !session) return;

    const fetchData = async () => {
      try {
        const portfolioData = await getPortfolioData();
        setHoldings(portfolioData?.holdings ?? []);
      } catch (error) {
        console.error("Error fetching portfolio data:", error);
      } finally {
        setLoading(false);
      }
    };

    void fetchData();
  }, [session, status]);

  if (status === "loading" || loading) {
    return (
      <DashboardLayout>
        <PortfolioLoadingState />
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout>
      <PortfolioClient initialHoldings={holdings} />
    </DashboardLayout>
  );
}
