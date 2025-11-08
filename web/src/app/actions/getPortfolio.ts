"use server";

import { auth } from "@/auth";
import { portfolioService } from "~/@/lib/portfolio-service";

export interface PortfolioData {
  holdings: Array<{
    symbol: string;
    shares: number;
    averagePrice: number;
  }>;
}

/**
 * Server action to fetch portfolio data
 * Used for SSR to provide initial portfolio state
 */
export async function getPortfolioData(): Promise<PortfolioData | null> {
  try {
    const session = await auth();

    if (!session?.user?.id) {
      return null;
    }

    // Fetch portfolio data server-side
    const portfolio = await portfolioService.getPortfolio();

    return {
      holdings: portfolio.holdings || [],
    };
  } catch (error) {
    console.error("Failed to fetch portfolio data:", error);
    return null;
  }
}
