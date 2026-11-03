import { createConnectTransport } from "@connectrpc/connect-web";
import { createClient } from "@connectrpc/connect";
import { unstable_cache } from "next/cache";
import { OwnershipService } from "~/gen/shorts/v1alpha1/ownership_pb";
import { formatPct } from "~/@/lib/fundamentals/format";
import { ageLabel } from "~/@/lib/ownership/age";
import { formatVotingPower, holderHref } from "~/@/lib/ownership/kinds";
import {
  SERVER_SHORTS_API_URL,
  serverFetchOutsideNextCache,
  skipForBuild,
} from "./config";
import {
  normalizeStockPageCacheCode,
  stockPageCacheTags,
} from "./stockPageCache";

// The Overview's register strip: a stock's largest substantial holders as its
// ASX notices state them, from OwnershipService.GetStockOwnership. It is a
// summary of the register page, so it reads what the page reads and no more.
// It never reads GetStock: that answers NotFound for a database error too.
//
// Contract, all of it load-bearing (getStockStrategyFit's, with its own key):
//   - unstable_cache key ["stock-register-strip", code, "v1"], revalidate 3600,
//     tags stockPageCacheTags("register-strip", code). Deliberately not tagged
//     "ownership": the sync's layout expiry and the hourly revalidate refresh
//     it, and the job's ping must not add a second regeneration wave to the
//     Overview;
//   - no KV entry under it: each entry is one database read, never a copy of
//     another cached entry;
//   - a serverFetchOutsideNextCache transport with a 4 s abort, so a slow API
//     costs the strip, never the render;
//   - errors are thrown INSIDE the cached function, so nothing failed is ever
//     cached; the caller's catch hides the strip;
//   - a response without a summary is not an answer (a database without the
//     ownership tables answers an empty message), so it throws too. A stock
//     with no current holder resolves null: that is a real answer, and cached.

/** Abort the RPC after this long: the strip is optional, the render is not. */
export const REGISTER_STRIP_TIMEOUT_MS = 4000;

/** The cache version of one stock's strip entry. */
export const REGISTER_STRIP_CACHE_VERSION = "v1";

/** The holders the strip names, largest voting power first. */
export const REGISTER_STRIP_ROWS = 3;

export interface StockRegisterStripRow {
  name: string;
  /** The holder's institution page, or its stock page when it is a listed company; null off the map. */
  href: string | null;
  /** The kind id, as KindBadge takes it. */
  kind: string;
  /** One notice's figure, to the precision it states. */
  votingPower: string;
  /** YYYY-MM-DD: the notice's event date, or its release date when it has none. */
  asAt: string;
  /** "" or "{n} mo" (ageLabel). */
  age: string;
}

export interface StockRegisterStrip {
  stockCode: string;
  /** Current substantial holders. */
  holders: number;
  /** Interests counted once: the kinds' holder counts, summed. */
  interests: number;
  /** What the notices disclose, to two decimals with its percent sign; "n/a" when unstated. */
  disclosed: string;
  /** The index funds' share of shares on issue, to two decimals and no percent sign (the copy adds it); null when there is no figure. */
  indexPct: string | null;
  indexAsAtFrom: string;
  indexAsAtTo: string;
  /** The newest notice release date read anywhere, YYYY-MM-DD; "" when none. */
  asOf: string;
  rows: StockRegisterStripRow[];
}

/** The GetStockOwnership fields the strip reads (the message satisfies it). */
export interface StockRegisterStripResponseLike {
  asOf?: string;
  summary?: {
    holders?: number;
    disclosedPct?: number;
    byKind?: ReadonlyArray<{ holders?: number }>;
    hasIndexPct?: boolean;
    indexPct?: number;
    indexAsAtFrom?: string;
    indexAsAtTo?: string;
  } | null;
  holders?: ReadonlyArray<{
    holderName?: string;
    institutionSlug?: string;
    holderKey?: string;
    kind?: string;
    votingPowerPct?: number;
    eventDate?: string;
    announcedOn?: string;
  }>;
}

/**
 * A GetStockOwnership response to the strip's plain shape. THROWS without a
 * summary, the one predicate the register page shares; null when no holder is
 * current. The counts and sums are the summary's, so the strip and the page
 * agree on them.
 */
export function mapStockRegisterStrip(
  code: string,
  response: StockRegisterStripResponseLike,
): StockRegisterStrip | null {
  const summary = response.summary;
  if (summary == null) {
    throw new Error(`ownership summary missing for ${code}`);
  }
  const holders = response.holders ?? [];
  if (holders.length === 0) return null;

  const asOf = response.asOf ?? "";
  const rows = [...holders]
    .sort(
      (a, b) =>
        (b.votingPowerPct ?? 0) - (a.votingPowerPct ?? 0) ||
        (a.holderName ?? "").localeCompare(b.holderName ?? ""),
    )
    .slice(0, REGISTER_STRIP_ROWS)
    .map((holder): StockRegisterStripRow => {
      // An empty date is absent: a notice without an event date sits on its
      // release date, as holdingRow reads it.
      const asAt = holder.eventDate ? holder.eventDate : (holder.announcedOn ?? "");
      const name = holder.holderName?.trim();
      return {
        name: name ? name : "Unnamed holder",
        href: holderHref(holder.institutionSlug, holder.holderKey),
        kind: holder.kind ?? "",
        votingPower: formatVotingPower(holder.votingPowerPct),
        asAt,
        age: ageLabel(asAt, asOf),
      };
    });

  const interests = (summary.byKind ?? []).reduce(
    (total, kind) => total + (kind.holders ?? 0),
    0,
  );
  const indexPct =
    summary.hasIndexPct === true &&
    typeof summary.indexPct === "number" &&
    Number.isFinite(summary.indexPct)
      ? summary.indexPct.toFixed(2)
      : null;

  return {
    stockCode: code,
    holders: summary.holders ?? 0,
    interests,
    disclosed: formatPct(summary.disclosedPct, { digits: 2 }),
    indexPct,
    indexAsAtFrom: summary.indexAsAtFrom ?? "",
    indexAsAtTo: summary.indexAsAtTo ?? "",
    asOf,
    rows,
  };
}

function ownershipClient() {
  const transport = createConnectTransport({
    fetch: serverFetchOutsideNextCache,
    baseUrl: SERVER_SHORTS_API_URL,
  });
  return createClient(OwnershipService, transport);
}

/** Runs `call` with an AbortSignal that fires after REGISTER_STRIP_TIMEOUT_MS. */
async function withTimeout<T>(
  call: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REGISTER_STRIP_TIMEOUT_MS);
  try {
    return await call(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

async function fetchStrip(code: string): Promise<StockRegisterStrip | null> {
  const response = await withTimeout((signal) =>
    ownershipClient().getStockOwnership(
      { stockCode: code },
      { signal, timeoutMs: REGISTER_STRIP_TIMEOUT_MS },
    ),
  );
  // Plain data only in the cache: never a protobuf message object.
  return mapStockRegisterStrip(code, response);
}

/**
 * One stock's register strip, or null when no holder is current. THROWS on
 * any failure (a timeout, an API without the rpc, a build prerender): the
 * caller catches and hides the strip.
 */
export async function getStockRegisterStrip(
  stockCode: string,
): Promise<StockRegisterStrip | null> {
  const code = normalizeStockPageCacheCode(stockCode);
  if (skipForBuild()) {
    throw new Error("register strip is not fetched during the build prerender");
  }
  return unstable_cache(
    () => fetchStrip(code),
    ["stock-register-strip", code, REGISTER_STRIP_CACHE_VERSION],
    { revalidate: 3600, tags: stockPageCacheTags("register-strip", code) },
  )();
}
