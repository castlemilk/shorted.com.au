import { getStatisticsWithCache } from "~/lib/statistics";
import AboutClient from "./about-client";
import { type AboutPageStatistics } from "~/lib/statistics";

// Allow page to be cached but revalidated periodically
// This ensures the static shell is cached, while the data is fetched fresh periodically
export const revalidate = 60;

// Fallback statistics for when API is unavailable (preview mode, offline, etc.)
const FALLBACK_STATISTICS: AboutPageStatistics = {
  companyCount: 500,
  industryCount: 25,
  latestUpdateDate: null,
};

export default async function Page() {
  let statistics: AboutPageStatistics;

  try {
    // Fetch statistics on the server side
    // This uses the shared cache logic to ensure fast responses
    const { data } = await getStatisticsWithCache();
    
    // Validate the data - use fallback if we got zeros
    if (data.companyCount > 0) {
      statistics = data;
    } else {
      statistics = FALLBACK_STATISTICS;
    }
  } catch (error) {
    // Graceful degradation - use fallback statistics if fetch fails
    console.error("Failed to fetch statistics for about page:", error);
    statistics = FALLBACK_STATISTICS;
  }

  return <AboutClient initialStatistics={statistics} />;
}
