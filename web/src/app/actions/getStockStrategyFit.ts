import { createConnectTransport } from "@connectrpc/connect-web";
import { createClient } from "@connectrpc/connect";
import { unstable_cache } from "next/cache";
import { StrategyService } from "~/gen/shorts/v1alpha1/strategies_pb";
import {
  SERVER_SHORTS_API_URL,
  serverFetchOutsideNextCache,
  skipForBuild,
} from "./config";
import {
  normalizeStockPageCacheCode,
  stockPageCacheTags,
} from "./stockPageCache";

// How every picker strategy reads one stock, for the Strategy fit card in the
// stock page's Overview (docs/plans/fundamentals-coverage.md §7.1), from
// StrategyService.GetStockStrategyFit.
//
// Contract, all of it load-bearing:
//   - unstable_cache key ['stock-strategy-fit', code, 'v1'], revalidate 3600,
//     tags ['strategy-picks', ...stockPageCacheTags('strategy-fit', code)];
//   - a serverFetchOutsideNextCache transport with a 4 s abort, so a slow API
//     costs the card, never the render;
//   - errors are thrown INSIDE the cached function (never cached) and are the
//     CALLER's to catch: the page hides the card, and the fetch is never part
//     of the page's critical Promise.all, so a failure never fails the ISR
//     render.
//
// Rule titles are static per strategy (they change only with a deploy), so
// they come from ListStrategies under their own cache entry. A failure there
// degrades the titles to readable rule ids and is never merged into the fit
// entry, so it cannot pin a degraded card for an hour.

/** Abort the RPC after this long: the card is optional, the render is not. */
export const STRATEGY_FIT_TIMEOUT_MS = 4000;

/** The cache version of one stock's fit entry. */
export const STRATEGY_FIT_CACHE_VERSION = "v1";

export type StrategyFitStatus = "triggered" | "setup" | "watch" | "none";
export type StrategyFitRuleStatus = "pass" | "fail" | "unknown";

export interface StrategyFitRule {
  ruleId: string;
  status: StrategyFitRuleStatus;
  /** Human-readable evidence. */
  detail: string;
}

export interface StrategyFitRuleColumn {
  id: string;
  title: string;
}

export interface StockStrategyFitRow {
  strategyId: string;
  strategyName: string;
  /** "none" when the stock is not a candidate for the strategy. */
  status: StrategyFitStatus;
  /** 0-100; null when the stock is not a candidate. */
  score: number | null;
  /** 1-based rank among the strategy's picks; null when not a candidate. */
  rank: number | null;
  /** Picks the strategy has in total; null when unknown. */
  totalCount: number | null;
  rules: StrategyFitRule[];
  /** The strategy's rules in order, for the dots and their labels. */
  ruleColumns: StrategyFitRuleColumn[];
}

export interface StockStrategyFit {
  stockCode: string;
  /** YYYY-MM-DD of the latest price in the universe; "" when unknown. */
  asOf: string;
  inUniverse: boolean;
  fits: StockStrategyFitRow[];
}

/** strategy id -> rule id -> title. */
export type StrategyRuleTitles = Record<string, Record<string, string>>;

/** The GetStockStrategyFit fields the mapper reads (the message satisfies it). */
export interface StockStrategyFitResponseLike {
  asOf?: string;
  inUniverse?: boolean;
  fits?: ReadonlyArray<{
    strategyId?: string;
    strategyName?: string;
    status?: string;
    score?: number;
    rank?: number;
    totalCount?: number;
    rules?: ReadonlyArray<{ ruleId?: string; status?: string; detail?: string }>;
  }>;
}

/** The ListStrategies fields the title map reads (the message satisfies it). */
export interface ListStrategiesResponseLike {
  strategies?: ReadonlyArray<{
    id?: string;
    rules?: ReadonlyArray<{ id?: string; title?: string }>;
  }>;
}

function text(value: string | undefined | null): string {
  return typeof value === "string" ? value.trim() : "";
}

function toStatus(value: string | undefined): StrategyFitStatus {
  const status = text(value).toLowerCase();
  return status === "triggered" || status === "setup" || status === "watch"
    ? status
    : "none";
}

function toRuleStatus(value: string | undefined): StrategyFitRuleStatus {
  const status = text(value).toLowerCase();
  return status === "pass" || status === "fail" ? status : "unknown";
}

function positiveInt(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : null;
}

/** "revenue_growth" -> "Revenue growth": a readable stand-in for a missing title. */
export function humaniseRuleId(id: string): string {
  const words = text(id).replace(/[_-]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "Rule";
}

/**
 * A GetStockStrategyFit response to the card's plain shape. Without `titles`
 * the rule columns carry humanised ids; applyRuleTitles fills the real ones.
 */
export function mapStockStrategyFit(
  code: string,
  response: StockStrategyFitResponseLike,
  titles: StrategyRuleTitles = {},
): StockStrategyFit {
  const fits = (response.fits ?? [])
    .filter((fit) => text(fit.strategyId) !== "")
    .map((fit): StockStrategyFitRow => {
      const status = toStatus(fit.status);
      const candidate = status !== "none";
      const rules = (fit.rules ?? [])
        .filter((rule) => text(rule.ruleId) !== "")
        .map((rule) => ({
          ruleId: text(rule.ruleId),
          status: toRuleStatus(rule.status),
          detail: text(rule.detail),
        }));
      const strategyId = text(fit.strategyId);
      const strategyTitles = titles[strategyId] ?? {};
      return {
        strategyId,
        strategyName: text(fit.strategyName) || strategyId,
        status,
        score:
          candidate &&
          typeof fit.score === "number" &&
          Number.isFinite(fit.score)
            ? fit.score
            : null,
        rank: candidate ? positiveInt(fit.rank) : null,
        totalCount: positiveInt(fit.totalCount),
        rules,
        ruleColumns: rules.map((rule) => ({
          id: rule.ruleId,
          title: strategyTitles[rule.ruleId] ?? humaniseRuleId(rule.ruleId),
        })),
      };
    });
  return {
    stockCode: code,
    asOf: text(response.asOf),
    inUniverse: response.inUniverse === true,
    fits,
  };
}

/** Replaces humanised rule titles with the strategy's own, where known. */
export function applyRuleTitles(
  fit: StockStrategyFit,
  titles: StrategyRuleTitles,
): StockStrategyFit {
  return {
    ...fit,
    fits: fit.fits.map((row) => {
      const strategyTitles = titles[row.strategyId];
      if (!strategyTitles) return row;
      return {
        ...row,
        ruleColumns: row.ruleColumns.map((column) => ({
          id: column.id,
          title: strategyTitles[column.id] ?? column.title,
        })),
      };
    }),
  };
}

/** ListStrategies to strategy id -> rule id -> title. */
export function mapRuleTitles(
  response: ListStrategiesResponseLike,
): StrategyRuleTitles {
  const out: StrategyRuleTitles = {};
  for (const strategy of response.strategies ?? []) {
    const id = text(strategy.id);
    if (!id) continue;
    const titles: Record<string, string> = {};
    for (const rule of strategy.rules ?? []) {
      const ruleId = text(rule.id);
      const title = text(rule.title);
      if (ruleId && title) titles[ruleId] = title;
    }
    out[id] = titles;
  }
  return out;
}

function strategyClient() {
  const transport = createConnectTransport({
    fetch: serverFetchOutsideNextCache,
    baseUrl: SERVER_SHORTS_API_URL,
  });
  return createClient(StrategyService, transport);
}

/** Runs `call` with an AbortSignal that fires after STRATEGY_FIT_TIMEOUT_MS. */
async function withTimeout<T>(
  call: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), STRATEGY_FIT_TIMEOUT_MS);
  try {
    return await call(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

async function fetchFit(code: string): Promise<StockStrategyFit> {
  const client = strategyClient();
  const response = await withTimeout((signal) =>
    client.getStockStrategyFit(
      { stockCode: code },
      { signal, timeoutMs: STRATEGY_FIT_TIMEOUT_MS },
    ),
  );
  // Plain data only in the cache: never a protobuf message object.
  return mapStockStrategyFit(code, response);
}

async function fetchRuleTitles(): Promise<StrategyRuleTitles> {
  const client = strategyClient();
  const response = await withTimeout((signal) =>
    client.listStrategies({}, { signal, timeoutMs: STRATEGY_FIT_TIMEOUT_MS }),
  );
  const titles = mapRuleTitles(response);
  // No strategies is a broken backend, not an answer: never cache it.
  if (Object.keys(titles).length === 0) {
    throw new Error("ListStrategies returned no strategies");
  }
  return titles;
}

/** The cache tags of one stock's fit entry. */
export function stockStrategyFitCacheTags(code: string): string[] {
  return ["strategy-picks", ...stockPageCacheTags("strategy-fit", code)];
}

/**
 * Every strategy's reading of `stockCode`. THROWS on any failure (a timeout,
 * an API without the rpc, a build prerender): the caller catches and hides the
 * card. A stock outside the universe resolves with `fits: []`.
 */
export async function getStockStrategyFit(
  stockCode: string,
): Promise<StockStrategyFit> {
  const code = normalizeStockPageCacheCode(stockCode);
  if (skipForBuild()) {
    throw new Error("strategy fit is not fetched during the build prerender");
  }
  const [fit, titles] = await Promise.all([
    unstable_cache(
      () => fetchFit(code),
      ["stock-strategy-fit", code, STRATEGY_FIT_CACHE_VERSION],
      { revalidate: 3600, tags: stockStrategyFitCacheTags(code) },
    )(),
    unstable_cache(fetchRuleTitles, ["stock-strategy-fit-rule-titles", "v1"], {
      revalidate: 3600,
      tags: ["strategy-picks", "strategies-list"],
    })().catch((err: unknown): StrategyRuleTitles => {
      console.warn("[getStockStrategyFit] rule titles unavailable:", err);
      return {};
    }),
  ]);
  return applyRuleTitles(fit, titles);
}
