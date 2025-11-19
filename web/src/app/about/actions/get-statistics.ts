export interface AboutPageStatistics {
  companyCount: number;
  industryCount: number;
  latestUpdateDate: Date | null;
}

interface StatisticsResponse {
  companyCount?: number;
  industryCount?: number;
  latestUpdateDate?: string | null;
}

/**
 * Get statistics for the about page
 * Fetches from API route for SSR compatibility
 */
export const getAboutStatistics = async (): Promise<AboutPageStatistics> => {
  try {
    // Use relative URL for client-side fetching
    // The API route will check KV cache first for instant responses
    const response = await fetch("/api/about/statistics", {
      cache: "no-store", // Always fetch fresh data on client
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => response.statusText);
      console.error(`Statistics API error (${response.status}):`, errorText);
      throw new Error(
        `Failed to fetch statistics: ${response.status} ${errorText}`,
      );
    }

    const data = (await response.json()) as StatisticsResponse;

    // Debug logging
    if (process.env.NODE_ENV === "development") {
      console.log("Statistics fetched:", data);
    }

    // Handle date deserialization (could be Date object or ISO string from cache)
    let latestDate: Date | null = null;
    if (data.latestUpdateDate) {
      if (
        data.latestUpdateDate &&
        typeof data.latestUpdateDate === "object" &&
        "getTime" in data.latestUpdateDate
      ) {
        latestDate = data.latestUpdateDate as Date;
      } else if (typeof data.latestUpdateDate === "string") {
        latestDate = new Date(data.latestUpdateDate);
      }
    }

    return {
      companyCount: data.companyCount ?? 0,
      industryCount: data.industryCount ?? 0,
      latestUpdateDate: latestDate,
    };
  } catch (error) {
    console.error("Error fetching statistics:", error);
    // Return safe defaults on error
    return {
      companyCount: 0,
      industryCount: 0,
      latestUpdateDate: null,
    };
  }
};
