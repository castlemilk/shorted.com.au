import { cache } from "react";
import {
  DISCOVERY_PAGE_SIZE,
  DISCOVERY_WINDOW,
  readDiscovery,
} from "~/@/lib/ownership/investor-disclosures";
import { skipForBuild } from "./config";
import { ownershipClient } from "./ownership-shared";

export const getInvestorDiscovery = cache(() => {
  const client = ownershipClient();
  return readDiscovery(async (cursor) => {
    if (skipForBuild()) return undefined;
    try {
      return await client.listSubstantialNotices(
        {
          cursor,
          limit: DISCOVERY_PAGE_SIZE,
          windowDays: DISCOVERY_WINDOW,
          kind: "unclassified",
          includeActivity: false,
        },
        { timeoutMs: 10000 },
      );
    } catch (error) {
      console.warn(
        "[ownership] Australian investor discovery page unavailable",
        error,
      );
      return undefined;
    }
  });
});
