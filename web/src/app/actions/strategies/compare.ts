"use server";

// The compare page's read: CompareStrategies for two or three canonical strategies,
// signed in only (the API answers PRIVATE). The call is per request and never enters a
// shared cache: this module imports no cache helper of any kind, and the identity
// comes from createSignedInTransport, which reads the session itself. It follows
// viewer.ts, the signed-in pattern of the strategy workspace.

import { createClient } from "@connectrpc/connect";

import {
  mapCompareStrategies,
  type CompareStrategiesView,
} from "~/@/lib/strategies/map-backtest";
import { StrategyService } from "~/gen/shorts/v1alpha1/strategies_pb";
import { auth } from "~/server/auth";
import { createSignedInTransport } from "../auth-transport";

const STRATEGY_ID = /^[a-z0-9-]{1,64}$/;

export type CompareResult =
  | { ok: true; comparison: CompareStrategiesView }
  | { ok: false; reason: "signed-out" | "invalid" | "unavailable" };

/**
 * Two or three distinct canonical strategy ids, compared over their common window.
 * An anonymous caller gets "signed-out" without a call to the API; a malformed or
 * repeated list gets "invalid" without one too.
 */
export async function compareStrategiesForViewer(
  refs: readonly string[],
): Promise<CompareResult> {
  const ids = Array.isArray(refs) ? refs.map((r) => (typeof r === "string" ? r : "")) : [];
  const unique = [...new Set(ids)];
  if (
    unique.length < 2 ||
    unique.length > 3 ||
    unique.length !== ids.length ||
    !unique.every((id) => STRATEGY_ID.test(id))
  ) {
    return { ok: false, reason: "invalid" };
  }

  const session = await auth();
  if (!session?.user?.id) return { ok: false, reason: "signed-out" };

  try {
    // Identity only: the comparison never sends the address or the verification flag.
    const { transport } = await createSignedInTransport({ withEmail: false });
    const client = createClient(StrategyService, transport);
    const response = await client.compareStrategies({ refs: unique });
    return { ok: true, comparison: mapCompareStrategies(response) };
  } catch (err) {
    console.warn("[compareStrategiesForViewer] unavailable:", err);
    return { ok: false, reason: "unavailable" };
  }
}
