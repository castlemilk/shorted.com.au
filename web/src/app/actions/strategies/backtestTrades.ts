"use server";

// The trade list of one canonical backtest run (ListBacktestTrades), for signed-in
// callers only (2.2: anonymous visitors get the public summary on the Trades tab).
// The list is per-viewer data in the sense that it is read only for a session, so
// this module imports no cache helper of any kind: a signed-in answer is never
// shared. A signed-out caller gets "signed-out" without any call to the API.

import { createClient } from "@connectrpc/connect";

import {
  mapBacktestTradesPage,
  type BacktestTradesPageView,
} from "~/@/lib/strategies/map-backtest";
import { StrategyService } from "~/gen/shorts/v1alpha1/strategies_pb";
import { auth } from "~/server/auth";
import { createSignedInTransport } from "../auth-transport";

export type BacktestTradesResult =
  | { ok: true; page: BacktestTradesPageView }
  | { ok: false; reason: "signed-out" | "unavailable" }
  | { ok: false; reason: "invalid"; error: TradesFilterError };

export interface BacktestTradesInput {
  runId: number;
  pageToken?: string;
  pageSize?: number;
  stockCode?: string;
  exitReason?: string;
}

const PAGE_SIZE_MAX = 200;
const PAGE_SIZE_DEFAULT = 50;
/** A stock code is one to six letters or digits (the ASX code form). */
const STOCK_CODE_PATTERN = /^[A-Z0-9]{1,6}$/;
/** An exit reason is a snake_case word the engine writes (5.10). */
const EXIT_REASON_PATTERN = /^[a-z_]{1,64}$/;
/** The page token is the API's opaque token: bounded, and no characters outside its alphabet. */
const PAGE_TOKEN_PATTERN = /^[A-Za-z0-9_\-=+/]{0,512}$/;

/** Filter feedback, named so the island can print it (never a silent drop). */
export type TradesFilterError = "stock" | "reason" | "token";

function validateTradesFilters(input: {
  stockCode?: string;
  exitReason?: string;
  pageToken?: string;
}): { ok: true; stockCode: string; exitReason: string; pageToken: string } | { ok: false; error: TradesFilterError } {
  // A value that is not a string is a bad filter, reported as one (never a thrown TypeError).
  if (input.stockCode !== undefined && typeof input.stockCode !== "string") return { ok: false, error: "stock" };
  if (input.exitReason !== undefined && typeof input.exitReason !== "string") return { ok: false, error: "reason" };
  if (input.pageToken !== undefined && typeof input.pageToken !== "string") return { ok: false, error: "token" };
  const stockCode = (input.stockCode ?? "").trim().toUpperCase();
  const exitReason = (input.exitReason ?? "").trim();
  const pageToken = input.pageToken ?? "";
  if (stockCode !== "" && !STOCK_CODE_PATTERN.test(stockCode)) return { ok: false, error: "stock" };
  if (exitReason !== "" && !EXIT_REASON_PATTERN.test(exitReason)) return { ok: false, error: "reason" };
  if (!PAGE_TOKEN_PATTERN.test(pageToken)) return { ok: false, error: "token" };
  return { ok: true, stockCode, exitReason, pageToken };
}

export async function listBacktestTrades(
  input: BacktestTradesInput,
): Promise<BacktestTradesResult> {
  try {
    const runId = Number(input?.runId);
    if (!Number.isInteger(runId) || runId <= 0) return { ok: false, reason: "unavailable" };

    const session = await auth();
    if (!session?.user?.id) return { ok: false, reason: "signed-out" };

    const filters = validateTradesFilters(input);
    if (!filters.ok) return { ok: false, reason: "invalid", error: filters.error };

    const pageSize = Math.min(
      PAGE_SIZE_MAX,
      Math.max(1, Math.trunc(Number(input.pageSize) || PAGE_SIZE_DEFAULT)),
    );
    // Identity only: this read never sends the address or the verification flag.
    const { transport } = await createSignedInTransport({ withEmail: false });
    const client = createClient(StrategyService, transport);
    const response = await client.listBacktestTrades({
      runId: BigInt(runId),
      pageToken: filters.pageToken,
      pageSize,
      stockCode: filters.stockCode,
      exitReason: filters.exitReason,
    });
    return { ok: true, page: mapBacktestTradesPage(response) };
  } catch (err) {
    console.warn(`[listBacktestTrades] unavailable for run ${input?.runId}:`, err);
    return { ok: false, reason: "unavailable" };
  }
}
