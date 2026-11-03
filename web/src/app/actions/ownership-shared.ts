/**
 * The ownership reads' shared plumbing: the ISR-tagged transport and the KV
 * last-good layer, used by both action files, getOwnership.ts (the page reads)
 * and ownershipExplorer.ts (the list pages). One copy, so a change to the tag or
 * to the read rule reaches every read.
 *
 * A PLAIN SERVER MODULE, NOT "use server": it exports the client and the cached
 * read for the actions to call, and no action of its own.
 */

import { createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-web";
import { fromJson, toJson, type JsonValue } from "@bufbuild/protobuf";
import { OwnershipService } from "~/gen/shorts/v1alpha1/ownership_pb";
import { OWNERSHIP_TTL, getCached, setCached } from "@/lib/kv-cache";
import { SERVER_SHORTS_API_URL, serverFetchWithUserAgent } from "./config";

// ISR-tagged transport. LOAD-BEARING: without `next`, serverFetchWithUserAgent
// forces no-store on a POST at Vercel runtime, and an ISR regeneration throws
// "static to dynamic" (getPoliticians.ts, getEconomy.ts). The "ownership" tag is
// the one the job's revalidate expires.
const isrOwnershipFetch: typeof fetch = (input, init) =>
  serverFetchWithUserAgent(input, {
    ...init,
    next: { revalidate: 3600, tags: ["ownership"] },
  } as RequestInit);

export function ownershipClient() {
  return createClient(
    OwnershipService,
    createConnectTransport({ fetch: isrOwnershipFetch, baseUrl: SERVER_SHORTS_API_URL }),
  );
}

/** The schema argument of fromJson: a generated message's schema. */
export type ProtoSchema = Parameters<typeof fromJson>[0];

/**
 * The KV last-good layer. A stored answer is served while it parses and
 * `isPopulated` keeps it, and an entry the current proto cannot parse is read
 * again, never rendered. A fresh answer is written only when it is populated, and
 * a failed read (undefined) is never written: a database without the ownership
 * tables answers {}, and caching that would pin it for the TTL. An empty entry is
 * a miss (getPoliticians.ts readCached).
 */
export async function cachedRead<T>(
  key: string,
  schema: ProtoSchema,
  isPopulated: (value: T) => boolean,
  fetchFresh: () => Promise<T | undefined>,
): Promise<T | undefined> {
  const hit = await getCached<JsonValue>(key);
  if (hit != null) {
    try {
      const parsed = fromJson(schema, hit) as T;
      if (isPopulated(parsed)) return parsed;
    } catch {
      // The proto changed since the entry was written: read fresh.
    }
  }
  const fresh = await fetchFresh();
  if (fresh !== undefined && isPopulated(fresh)) {
    try {
      void setCached(key, toJson(schema, fresh as never) as JsonValue, OWNERSHIP_TTL);
    } catch {
      // Never let a cache write break a render.
    }
  }
  return fresh;
}
