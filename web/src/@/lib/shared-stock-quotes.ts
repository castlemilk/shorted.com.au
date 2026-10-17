import { createHash, randomUUID } from "node:crypto";
import {
  acquireCacheLease,
  getCached,
  getCachedMany,
  releaseCacheLease,
  setCached,
  setCachedMany,
} from "./kv-cache";

// Yahoo supplies daily candles. Keep the candle's date intact, and retain the
// last good value for outages without renewing its freshness on failed reads.
export const QUOTE_FRESH_MS = 30 * 60 * 1000;
const MISSING_FRESH_MS = 5 * 60 * 1000;
const RETAIN_SECONDS = 24 * 60 * 60;
const GENERATION_KEY = "cache:quotes:v1:generation";
const quoteKey = (code: string, generation: string) =>
  `cache:quotes:v1:${generation}:${code}`;
function cacheGeneration(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "id" in value && typeof value.id === "string") return value.id;
  return "initial";
}
type Quote = Record<string, unknown> & {
  stockCode: string;
  date: string;
  close: number;
};
type Entry = { generation: string; fetchedAt: number; quote: Quote | null };
type QuoteResult = {
  prices: Record<string, Quote>;
  cache: "HIT" | "MISS" | "STALE";
};
export type QuoteLoader = (
  codes: string[],
  signal: AbortSignal,
) => Promise<unknown>;
type Flight = {
  promise: Promise<Map<string, Entry>>;
  controller: AbortController;
  users: number;
  settled: boolean;
};
// Only public quote data is shared. A consumer's cancellation releases its own
// subscription; the upstream is canceled only after its last consumer leaves.
const flights = new Map<string, Flight>();

export function normalizeQuoteCodes(body: unknown): string[] {
  const codes = (body as { stockCodes?: unknown } | null)?.stockCodes;
  if (
    !Array.isArray(codes) ||
    codes.length === 0 ||
    codes.length > 50 ||
    codes.some(
      (code) =>
        typeof code !== "string" ||
        !/^[A-Z]{3,4}$/.test(code.trim().toUpperCase()),
    )
  ) {
    throw new TypeError("Provide 1–50 stock codes of 3–4 letters");
  }
  return Array.from(
    new Set(codes.map((code) => (code as string).trim().toUpperCase())),
  ).sort();
}

function validQuote(value: unknown, code: string): value is Quote {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const q = value as Quote;
  if (
    q.stockCode !== code ||
    typeof q.close !== "number" ||
    !Number.isFinite(q.close) ||
    q.close <= 0 ||
    typeof q.date !== "string" ||
    !Number.isFinite(Date.parse(q.date)) ||
    Date.parse(q.date) > Date.now() + 86400_000
  )
    return false;
  // Proto JSON omits zero-valued scalars, including a zero daily change.
  for (const field of [
    "open",
    "high",
    "low",
    "adjustedClose",
    "change",
    "changePercent",
  ]) {
    if (
      q[field] !== undefined &&
      (typeof q[field] !== "number" || !Number.isFinite(q[field]))
    )
      return false;
  }
  return (
    q.volume === undefined ||
    (typeof q.volume === "string" && /^\d+$/.test(q.volume)) ||
    (typeof q.volume === "number" &&
      Number.isSafeInteger(q.volume) &&
      q.volume >= 0)
  );
}

function validEntry(
  value: unknown,
  code: string,
  generation: string,
): value is Entry {
  if (!value || typeof value !== "object") return false;
  const e = value as Entry;
  return (
    e.generation === generation &&
    typeof e.fetchedAt === "number" &&
    Number.isFinite(e.fetchedAt) &&
    e.fetchedAt <= Date.now() &&
    Date.now() - e.fetchedAt < RETAIN_SECONDS * 1000 &&
    (e.quote === null || validQuote(e.quote, code))
  );
}
const fresh = (entry: Entry) =>
  Date.now() - entry.fetchedAt <
  (entry.quote ? QUOTE_FRESH_MS : MISSING_FRESH_MS);
function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Aborted", "AbortError");
}
function wait<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      cleanup();
      reject(abortReason(signal));
    };
    const cleanup = () => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}
async function pause(ms: number, signal: AbortSignal): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await wait(
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
      }),
      signal,
    );
  } finally {
    clearTimeout(timer);
  }
}

async function refresh(
  codes: string[],
  generation: string,
  load: QuoteLoader,
  controller: AbortController,
  known: Map<string, Entry>,
): Promise<Map<string, Entry>> {
  // Node 24 supports any(); this app's older DOM type library does not yet.
  const signal = (
    AbortSignal as typeof AbortSignal & {
      any: (signals: AbortSignal[]) => AbortSignal;
    }
  ).any([controller.signal, AbortSignal.timeout(55_000)]);
  const leaseKey = `cache:quotes:lease:${createHash("sha256")
    .update(`${generation}:${codes.join(",")}`)
    .digest("hex")}`;
  const token = randomUUID();
  let lease: "acquired" | "busy" | "unavailable" = "unavailable";
  // A cross-instance waiter uses a handful of batched reads, not per-symbol
  // polling. Same-instance overlapping requests subscribe to the flight below.
  for (let attempt = 0; ; attempt++) {
    if (signal.aborted) throw abortReason(signal);
    lease = await acquireCacheLease(leaseKey, token, 60);
    if (lease !== "busy") break;
    await pause(Math.min(1000 * 2 ** attempt, 10_000), signal);
    const entries = await getCachedMany<Entry | string>([
      GENERATION_KEY,
      ...codes.map((code) => quoteKey(code, generation)),
    ]);
    if (cacheGeneration(entries[0]) !== generation)
      throw new Error("Quote cache invalidated during refresh");
    const ready = new Map<string, Entry>();
    codes.forEach((code, i) => {
      const entry = entries[i + 1];
      if (validEntry(entry, code, generation) && fresh(entry))
        ready.set(code, entry);
    });
    if (ready.size === codes.length) return ready;
  }
  try {
    const body = await load(codes, signal);
    if (signal.aborted) throw abortReason(signal);
    if (!body || typeof body !== "object" || Array.isArray(body))
      throw new Error("Invalid quote response");
    if (!("prices" in body) && Object.keys(body).length !== 0)
      throw new Error("Invalid quote response");
    const prices = "prices" in body ? (body as { prices: unknown }).prices : {};
    if (!prices || typeof prices !== "object" || Array.isArray(prices))
      throw new Error("Invalid quote prices");
    // Reject a malformed success as a whole: it must never become a negative
    // entry or erase a previously valid quote.
    for (const [code, quote] of Object.entries(prices)) {
      if (!codes.includes(code) || !validQuote(quote, code))
        throw new Error("Invalid quote in response");
    }
    const fetchedAt = Date.now();
    const entries = new Map<string, Entry>(
      codes.map((code) => [
        code,
        {
          generation,
          fetchedAt,
          quote: (prices as Record<string, Quote>)[code] ?? null,
        },
      ]),
    );
    const omitted = codes.filter((code) => !entries.get(code)?.quote);
    if (omitted.length) {
      const retained = await getCachedMany<Entry>(
        omitted.map((code) => quoteKey(code, generation)),
      );
      omitted.forEach((code, i) => {
        const stored = retained[i];
        const previous =
          validEntry(stored, code, generation) && stored.quote
            ? stored
            : known.get(code);
        // Empty/partial success must not erase a previously valid price, or
        // renew its age. Negative coverage is for symbols without a good quote.
        if (validEntry(previous, code, generation) && previous.quote)
          entries.set(code, previous);
      });
    }
    await setCachedMany(
      Array.from(entries)
        .filter(([, entry]) => entry.fetchedAt === fetchedAt)
        .map(([code, data]) => ({ key: quoteKey(code, generation), data })),
      RETAIN_SECONDS,
    );
    return entries;
  } finally {
    if (lease === "acquired") await releaseCacheLease(leaseKey, token);
  }
}

export async function getSharedStockQuotes(
  codes: string[],
  signal: AbortSignal,
  load: QuoteLoader,
): Promise<QuoteResult> {
  if (signal.aborted) throw abortReason(signal);
  const generation = cacheGeneration(await getCached<unknown>(GENERATION_KEY));
  const cached = await getCachedMany<Entry>(
    codes.map((code) => quoteKey(code, generation)),
  );
  if (signal.aborted) throw abortReason(signal);
  const entries = new Map<string, Entry>();
  const missing: string[] = [];
  codes.forEach((code, i) => {
    const entry = cached[i];
    if (validEntry(entry, code, generation)) entries.set(code, entry);
    if (!validEntry(entry, code, generation) || !fresh(entry))
      missing.push(code);
  });
  if (!missing.length) return { prices: pricesFrom(entries), cache: "HIT" };

  const joined = new Set<Flight>();
  const uncovered = missing.filter((code) => {
    const flight = flights.get(`${generation}:${code}`);
    if (!flight || flight.controller.signal.aborted) return true;
    joined.add(flight);
    return false;
  });
  if (uncovered.length) {
    const controller = new AbortController();
    const flight: Flight = {
      controller,
      users: 0,
      settled: false,
      promise: Promise.resolve(new Map<string, Entry>()),
    };
    uncovered.forEach((code) => flights.set(`${generation}:${code}`, flight));
    flight.promise = refresh(
      uncovered,
      generation,
      load,
      controller,
      entries,
    ).finally(() => {
      flight.settled = true;
      uncovered.forEach((code) => {
        if (flights.get(`${generation}:${code}`) === flight)
          flights.delete(`${generation}:${code}`);
      });
    });
    joined.add(flight);
  }
  joined.forEach((flight) => flight.users++);
  try {
    const results = await wait(
      Promise.all(Array.from(joined, (flight) => flight.promise)),
      signal,
    );
    results.forEach((result) =>
      result.forEach((entry, code) => {
        if (codes.includes(code) && (entry.quote !== null || !entries.get(code)?.quote))
          entries.set(code, entry);
      }),
    );
    return {
      prices: pricesFrom(entries),
      cache: Array.from(entries.values()).some(
        (entry) => entry.quote && !fresh(entry),
      )
        ? "STALE"
        : "MISS",
    };
  } catch (error) {
    if (signal.aborted) throw abortReason(signal);
    // Only fall back if every requested symbol already has a valid retained
    // result. Missing entries cannot turn an outage into a healthy empty map.
    if (codes.every((code) => entries.get(code)?.quote))
      return { prices: pricesFrom(entries), cache: "STALE" };
    throw error;
  } finally {
    joined.forEach((flight) => {
      if (--flight.users === 0 && !flight.settled) flight.controller.abort();
    });
  }
}

function pricesFrom(entries: Map<string, Entry>): Record<string, Quote> {
  return Object.fromEntries(
    Array.from(entries).flatMap(([code, entry]) =>
      entry.quote ? [[code, entry.quote]] : [],
    ),
  );
}

/** Generation change costs one SET; late old-generation writes stay invalid. */
export async function invalidateSharedStockQuotes(): Promise<boolean> {
  return setCached(GENERATION_KEY, { id: randomUUID() }, 90 * 24 * 60 * 60);
}
