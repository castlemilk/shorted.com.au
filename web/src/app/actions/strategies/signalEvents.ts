"use server";

// The signed-in viewer's signal history: ListStrategySignalEvents, the status
// changes of one strategy's live rules version (or of one stock's). It is
// private, free and up, so it goes through the signed-in transport and is read
// per request. Nothing here reaches a shared cache: a list of who moved is
// per-viewer data, and a guard test holds this module to that.

import { createClient } from "@connectrpc/connect";

import { mapSignalEventsResponse } from "~/@/lib/strategies/map";
import type { SignalEventsPage } from "~/@/lib/strategies/types";
import { StrategyService } from "~/gen/shorts/v1alpha1/strategies_pb";
import { auth } from "~/server/auth";
import { createSignedInTransport } from "../auth-transport";

/** The API's default and largest page for this read. */
const DEFAULT_PAGE = 20;
const MAX_PAGE = 200;

const STRATEGY_ID = /^[a-z0-9-]{1,64}$/;
const STOCK_CODE = /^[A-Z0-9]{1,6}$/;
const PAGE_TOKEN = /^\d{1,18}$/;

export type SignalEventsResult =
  | { ok: true; page: SignalEventsPage }
  | { ok: false; reason: "signed-out" | "unavailable" };

export interface SignalEventsInput {
  strategyId: string;
  /** Optional: one stock's changes only. */
  stockCode?: string;
  /** The next_page_token of the previous page. */
  pageToken?: string;
  pageSize?: number;
}

/**
 * One page of a strategy's status changes, newest first, for the signed-in
 * viewer. An anonymous caller gets "signed-out" without any call to the API, and
 * an input that does not parse gets "unavailable" without one either.
 */
export async function getSignalEventsForViewer(
  input: SignalEventsInput,
): Promise<SignalEventsResult> {
  const strategyId =
    typeof input?.strategyId === "string" ? input.strategyId : "";
  if (!STRATEGY_ID.test(strategyId)) return { ok: false, reason: "unavailable" };

  const stockCode =
    typeof input.stockCode === "string" ? input.stockCode.trim().toUpperCase() : "";
  if (stockCode !== "" && !STOCK_CODE.test(stockCode))
    return { ok: false, reason: "unavailable" };

  const pageToken =
    typeof input.pageToken === "string" ? input.pageToken : "";
  if (pageToken !== "" && !PAGE_TOKEN.test(pageToken))
    return { ok: false, reason: "unavailable" };

  const requested = Number.isInteger(input.pageSize) ? Number(input.pageSize) : DEFAULT_PAGE;
  const pageSize = Math.min(MAX_PAGE, Math.max(1, requested));

  const session = await auth();
  if (!session?.user?.id) return { ok: false, reason: "signed-out" };

  try {
    // Identity only: the history needs no address and no verification flag.
    const { transport } = await createSignedInTransport({ withEmail: false });
    const client = createClient(StrategyService, transport);
    const response = await client.listStrategySignalEvents({
      strategyId,
      versionHash: "",
      stockCode,
      since: "",
      pageToken,
      pageSize,
    });
    return { ok: true, page: mapSignalEventsResponse(response) };
  } catch (err) {
    console.warn(`[getSignalEventsForViewer] unavailable for ${strategyId}:`, err);
    return { ok: false, reason: "unavailable" };
  }
}
