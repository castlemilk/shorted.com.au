"use server";

import { auth } from "@/auth";
import { portfolioService } from "~/@/lib/portfolio-service";
import { retryWithBackoff } from "@/lib/retry";

export interface PortfolioData {
  holdings: Array<{
    symbol: string;
    shares: number;
    averagePrice: number;
  }>;
}

const RETRY_OPTIONS = {
  maxRetries: 3,
  initialDelayMs: 500,
  maxDelayMs: 5000,
};

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

    // Fetch portfolio data server-side with retry
    const portfolio = await retryWithBackoff(
      () => portfolioService.getPortfolio(),
      RETRY_OPTIONS,
    );

    return {
      holdings: portfolio.holdings || [],
    };
  } catch (error) {
    console.error("Failed to fetch portfolio data:", error);
    return null;
  }
}
