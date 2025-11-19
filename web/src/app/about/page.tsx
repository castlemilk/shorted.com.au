import { getStatisticsWithCache } from "~/lib/statistics";
import AboutClient from "./about-client";

// Allow page to be cached but revalidated periodically
// This ensures the static shell is cached, while the data is fetched fresh periodically
export const revalidate = 60;

export default async function Page() {
  // Fetch statistics on the server side
  // This uses the shared cache logic to ensure fast responses
  const { data } = await getStatisticsWithCache();

  return <AboutClient initialStatistics={data} />;
}
