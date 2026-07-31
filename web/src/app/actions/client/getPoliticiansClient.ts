import { createConnectTransport } from "@connectrpc/connect-web";
import { createClient } from "@connectrpc/connect";
import {
  PoliticiansService,
  type ComparePoliticiansResponse,
  type ListStockPoliticiansResponse,
  type ListSuburbPoliticiansResponse,
  type ListStatePoliticianHoldingsResponse,
} from "~/gen/shorts/v1alpha1/politicians_pb";
import { SHORTS_API_URL } from "../config";
import { retryWithBackoff } from "@/lib/retry";
import { getSessionCached, setSessionCached } from "@/lib/session-cache";

const RETRY_OPTIONS = { maxRetries: 3, initialDelayMs: 500, maxDelayMs: 5000 };

/**
 * In the browser the baseUrl is relative, so requests go through the
 * next.config rewrite (and the Cloudflare Worker cache) rather than cross-origin
 * to Cloud Run. That rewrite already matches any
 * shorts.v1alpha1.[A-Za-z]+Service, so PoliticiansService needed no config change.
 */
function client() {
  const transport = createConnectTransport({
    baseUrl: typeof window !== "undefined" ? "" : SHORTS_API_URL,
  });
  return createClient(PoliticiansService, transport);
}

/** Parliamentarians declaring an interest in one company (stock-page card). */
export async function listStockPoliticiansClient(
  stockCode: string,
): Promise<ListStockPoliticiansResponse | undefined> {
  if (!stockCode) return undefined;
  const code = stockCode.toUpperCase();
  const cacheKey = `politicians:stock:${code}`;
  const cached = getSessionCached<ListStockPoliticiansResponse>(cacheKey);
  if (cached) return cached;

  try {
    const result = await retryWithBackoff(
      () => client().listStockPoliticians({ stockCode: code }),
      RETRY_OPTIONS,
    );
    setSessionCached(cacheKey, result);
    return result;
  } catch {
    // The card renders nothing on failure rather than an error state: an
    // absence claim about named individuals is not something to assert loudly.
    return undefined;
  }
}

/** Parliamentarians declaring real estate in one suburb (housing card). */
export async function listSuburbPoliticiansClient(
  salCode: string,
): Promise<ListSuburbPoliticiansResponse | undefined> {
  if (!salCode) return undefined;
  const cacheKey = `politicians:suburb:${salCode}`;
  const cached = getSessionCached<ListSuburbPoliticiansResponse>(cacheKey);
  if (cached) return cached;

  try {
    const result = await retryWithBackoff(
      () => client().listSuburbPoliticians({ salCode }),
      RETRY_OPTIONS,
    );
    setSessionCached(cacheKey, result);
    return result;
  } catch {
    return undefined;
  }
}

/**
 * A comparison of two members' register summaries, for /politicians/compare.
 *
 * WHY THE `a === b` GUARD IS HERE AND NOT ONLY IN THE UI. The backend rejects a
 * request naming the same member twice with InvalidArgument, and
 * `shouldRetryConnectError` (correctly) treats InvalidArgument as terminal — so
 * the call would throw straight through to the catch below and the page would
 * report "unavailable" for what is really "you picked one person twice". The
 * picker states that case in its own words instead, so the request is never
 * made.
 *
 * THE NON-EMPTINESS PREDICATE IS NOT DECORATION. The register read paths have
 * already been bitten once by a cache that served an EMPTY entry as a hit and
 * pinned zeros for the whole TTL. A response missing either side is not a
 * comparison; it is neither stored nor served from the session cache.
 */
export async function comparePoliticiansClient(
  slugA: string,
  slugB: string,
): Promise<ComparePoliticiansResponse | undefined> {
  const a = slugA.trim();
  const b = slugB.trim();
  if (!a || !b || a === b) return undefined;

  const cacheKey = `politicians:compare:${a}:${b}`;
  const cached = getSessionCached<ComparePoliticiansResponse>(cacheKey);
  if (hasBothSides(cached)) return cached;

  try {
    const result = await retryWithBackoff(
      () => client().comparePoliticians({ slugA: a, slugB: b }),
      RETRY_OPTIONS,
    );
    if (hasBothSides(result)) setSessionCached(cacheKey, result);
    return result;
  } catch {
    // The surface renders a neutral "not available" state rather than an error
    // about two named individuals.
    return undefined;
  }
}

function hasBothSides(
  response: ComparePoliticiansResponse | null | undefined,
): response is ComparePoliticiansResponse {
  return Boolean(response?.a?.politician?.slug && response?.b?.politician?.slug);
}

/** Companies declared by one state's parliamentarians (economy card). */
export async function listStatePoliticianHoldingsClient(
  stateCode: string,
  limit = 8,
): Promise<ListStatePoliticianHoldingsResponse | undefined> {
  if (!stateCode) return undefined;
  const code = stateCode.toUpperCase();
  const cacheKey = `politicians:state:${code}:${limit}`;
  const cached = getSessionCached<ListStatePoliticianHoldingsResponse>(cacheKey);
  if (cached) return cached;

  try {
    const result = await retryWithBackoff(
      () => client().listStatePoliticianHoldings({ stateCode: code, limit }),
      RETRY_OPTIONS,
    );
    setSessionCached(cacheKey, result);
    return result;
  } catch {
    return undefined;
  }
}
