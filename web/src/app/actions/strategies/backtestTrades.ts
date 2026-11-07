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
  | { ok: false; reason: "signed-out" | "unavailable" };

export interface BacktestTradesInput {
  runId: number;
  pageToken?: string;
  pageSize?: number;
  stockCode?: string;
  exitReason?: string;
}

const PAGE_SIZE_MAX = 200;
const PAGE_SIZE_DEFAULT = 50;
const STOCK_CODE = /^[A-Z0-9]{1,6}$/;
const EXIT_REASON = /^[a-z_]{1,64}$/;

export async function listBacktestTrades(
  input: BacktestTradesInput,
): Promise<BacktestTradesResult> {
  const runId = Number(input?.runId);
  if (!Number.isInteger(runId) || runId <= 0) return { ok: false, reason: "unavailable" };

  const session = await auth();
  if (!session?.user?.id) return { ok: false, reason: "signed-out" };

  const pageSize = Math.min(
    PAGE_SIZE_MAX,
    Math.max(1, Math.trunc(Number(input.pageSize) || PAGE_SIZE_DEFAULT)),
  );
  const stockCode = (input.stockCode ?? "").trim().toUpperCase();
  const exitReason = (input.exitReason ?? "").trim();
  try {
    // Identity only: this read never sends the address or the verification flag.
    const { transport } = await createSignedInTransport({ withEmail: false });
    const client = createClient(StrategyService, transport);
    const response = await client.listBacktestTrades({
      runId: BigInt(runId),
      pageToken: input.pageToken ?? "",
      pageSize,
      stockCode: STOCK_CODE.test(stockCode) ? stockCode : "",
      exitReason: EXIT_REASON.test(exitReason) ? exitReason : "",
    });
    return { ok: true, page: mapBacktestTradesPage(response) };
  } catch (err) {
    console.warn(`[listBacktestTrades] unavailable for run ${runId}:`, err);
    return { ok: false, reason: "unavailable" };
  }
}
