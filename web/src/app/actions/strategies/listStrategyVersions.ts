import { createConnectTransport } from "@connectrpc/connect-web";
import { createClient } from "@connectrpc/connect";
import { unstable_cache } from "next/cache";
import { StrategyService } from "~/gen/shorts/v1alpha1/strategies_pb";
import {
  SHORTS_API_URL,
  serverFetchOutsideNextCache,
  skipForBuild,
} from "../config";
import { mapStrategyVersionDetail } from "~/@/lib/strategies/map";
import type { StrategyVersionDetailView } from "~/@/lib/strategies/types";

// Every published rules version of every strategy, for /strategies/changelog.
// Same pattern as getStrategies: connect inside unstable_cache, skipped at
// build, null on failure. The versions are served from code, so an empty list
// is a broken backend and throws, which keeps it out of the cache.

async function fetchStrategyVersions(): Promise<StrategyVersionDetailView[]> {
  const transport = createConnectTransport({
    fetch: serverFetchOutsideNextCache,
    baseUrl: SHORTS_API_URL,
  });
  const client = createClient(StrategyService, transport);
  const response = await client.listStrategyVersions({});
  return (response.versions ?? []).flatMap((detail) => {
    const mapped = mapStrategyVersionDetail(detail);
    return mapped ? [mapped] : [];
  });
}

export async function listStrategyVersions(): Promise<
  StrategyVersionDetailView[] | null
> {
  if (skipForBuild()) return null;
  try {
    return await unstable_cache(
      async () => {
        const versions = await fetchStrategyVersions();
        if (versions.length === 0) {
          throw new Error("ListStrategyVersions returned no versions");
        }
        return versions;
      },
      ["strategy-versions-v2"],
      { tags: ["strategy-picks", "strategy-versions"], revalidate: 3600 },
    )();
  } catch (err) {
    console.error("[listStrategyVersions] failed:", err);
    return null;
  }
}
