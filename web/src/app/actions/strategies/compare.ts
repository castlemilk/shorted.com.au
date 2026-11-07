"use server";

// The compare page's read: CompareStrategies for two or three canonical strategies, plus
// each strategy's survivorship statement from ListStrategyEvidence, signed in only (the
// comparison is PRIVATE). The calls are per request and never enter a shared cache: this
// module imports no cache helper of any kind (a guard test holds it to that). The identity
// comes from createSignedInTransport, which reads the session itself.

import { createClient } from "@connectrpc/connect";

import {
  mapCompareStrategies,
  mapListStrategyEvidence,
  type CompareStrategiesView,
} from "~/@/lib/strategies/map-backtest";
import { StrategyService } from "~/gen/shorts/v1alpha1/strategies_pb";
import { auth } from "~/server/auth";
import { createSignedInTransport } from "../auth-transport";

const STRATEGY_ID = /^[a-z0-9-]{1,64}$/;

/** Connect's status codes this module answers to (the protocol's numbers). */
const CODE_INVALID_ARGUMENT = 3;
const CODE_PERMISSION_DENIED = 7;
const CODE_NOT_FOUND = 5;
const CODE_UNAUTHENTICATED = 16;

/**
 * The reasons a comparison cannot be drawn. "invalid" (a malformed list), "not-found" (an id the
 * API does not hold) and "signed-out" (no session the API accepts) are permanent: a retry will not
 * change them. "unavailable" is transient.
 */
export type CompareFailure = "signed-out" | "invalid" | "not-found" | "unavailable";

export type CompareResult =
  | {
      ok: true;
      comparison: CompareStrategiesView;
      /** Each strategy's survivorship statement, by id; "" when the evidence names none. */
      survivorship: Record<string, string>;
    }
  | { ok: false; reason: CompareFailure };

/** The status code of a Connect error, read by value so no module imports the Connect runtime for it. */
function connectCode(err: unknown): number | null {
  if (err === null || typeof err !== "object" || !("code" in err)) return null;
  const code = (err as { code: unknown }).code;
  return typeof code === "number" ? code : null;
}

function failureOf(err: unknown): CompareFailure {
  switch (connectCode(err)) {
    case CODE_INVALID_ARGUMENT:
      return "invalid";
    case CODE_NOT_FOUND:
      return "not-found";
    case CODE_UNAUTHENTICATED:
    case CODE_PERMISSION_DENIED:
      return "signed-out";
    default:
      return "unavailable";
  }
}

/**
 * Two or three distinct canonical strategy ids, compared over their common window. A malformed
 * or repeated list answers "invalid" without a session or a call; an anonymous caller answers
 * "signed-out" without a call. Every failure after that is caught here, so the page never waits
 * on a rejection.
 */
export async function compareStrategiesForViewer(refs: readonly string[]): Promise<CompareResult> {
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

  try {
    const session = await auth();
    if (!session?.user?.id) return { ok: false, reason: "signed-out" };

    // Identity only: the comparison never sends the address or the verification flag.
    const { transport } = await createSignedInTransport({ withEmail: false });
    const client = createClient(StrategyService, transport);
    const [response, evidence] = await Promise.all([
      client.compareStrategies({ refs: unique }),
      client.listStrategyEvidence({}),
    ]);
    const survivorship = Object.fromEntries(
      mapListStrategyEvidence(evidence).strategies.map((s) => [s.strategyId, s.survivorship]),
    );
    return { ok: true, comparison: mapCompareStrategies(response), survivorship };
  } catch (err) {
    const reason = failureOf(err);
    console.warn(`[compareStrategiesForViewer] ${reason}:`, err);
    return { ok: false, reason };
  }
}
