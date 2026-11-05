"use server";

// The signed-in user's saved strategies: SaveStrategy, UnsaveStrategy and
// ListSavedStrategies. Each call is per-viewer and runs for the current request,
// so this module imports no cache helper of any kind (a guard test holds it to
// that). The identity comes from createSignedInTransport, which reads the session
// itself; no argument here names a user.

import { createClient } from "@connectrpc/connect";

import { parseEntitlementDetail } from "~/@/lib/strategies/entitlement";
import type { StatusCountsView } from "~/@/lib/strategies/types";
import { StrategyService } from "~/gen/shorts/v1alpha1/strategies_pb";
import { auth } from "~/server/auth";
import { createSignedInTransport } from "../auth-transport";

/** The most strategies one user may keep saved. The API reports the same figure. */
const SAVED_STRATEGY_LIMIT = 20;

const STRATEGY_REF = /^([a-z0-9-]{1,64}|variant:[A-Za-z0-9-]{1,64})$/;

/** One saved strategy as the My strategies list draws it. */
export interface SavedStrategyView {
  strategyRef: string;
  /** The canonical strategy id; empty for a variant. */
  strategyId: string;
  /** The strategy's name; empty when the API does not know it. */
  name: string;
  /** RFC 3339 time of the first save. */
  savedAt: string;
  /** Today's counts; null for a variant or when the API could not read them. */
  counts: StatusCountsView | null;
}

export type SavedListResult =
  | { ok: true; strategies: SavedStrategyView[]; limit: number }
  | { ok: false; reason: "signed-out" | "unavailable" };

export type SaveResult =
  | { ok: true; strategy: SavedStrategyView }
  | { ok: false; reason: "signed-out" | "limit" | "not-found" | "unavailable" };

export type UnsaveResult =
  | { ok: true }
  | { ok: false; reason: "signed-out" | "unavailable" };

/** The Connect status code this module answers to (the protocol's number). */
const CODE_NOT_FOUND = 5;

/** The capability the API names when a save is refused at the cap. */
const CAP_REACHED = "cap_reached";

/** The status code of a Connect error, read by value so no SSR-visible module imports it. */
function connectCode(err: unknown): number | null {
  if (err === null || typeof err !== "object" || !("code" in err)) return null;
  const code = (err as { code: unknown }).code;
  return typeof code === "number" ? code : null;
}

type StatusCountsInput = {
  triggered?: unknown;
  setup?: unknown;
  watch?: unknown;
  unknown?: unknown;
};

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : 0;
}

function countsOf(input: StatusCountsInput | null | undefined): StatusCountsView | null {
  if (!input) return null;
  return {
    triggered: count(input.triggered),
    setup: count(input.setup),
    watch: count(input.watch),
    unknown: count(input.unknown),
  };
}

type SavedInput = {
  strategyRef?: unknown;
  strategyId?: unknown;
  name?: unknown;
  savedAt?: unknown;
  statusCounts?: StatusCountsInput | null;
};

function savedOf(input: SavedInput): SavedStrategyView {
  return {
    strategyRef: typeof input.strategyRef === "string" ? input.strategyRef : "",
    strategyId: typeof input.strategyId === "string" ? input.strategyId : "",
    name: typeof input.name === "string" ? input.name : "",
    savedAt: typeof input.savedAt === "string" ? input.savedAt : "",
    counts: countsOf(input.statusCounts),
  };
}

/** A reference the page sends, checked before any call: a strategy id or "variant:<id>". */
function validRef(ref: unknown): ref is string {
  return typeof ref === "string" && STRATEGY_REF.test(ref.trim().toLowerCase());
}

async function signedInClient() {
  const session = await auth();
  if (!session?.user?.id) return null;
  const { transport } = await createSignedInTransport({ withEmail: false });
  return createClient(StrategyService, transport);
}

/** The signed-in user's saved strategies, most recent first. */
export async function listSavedStrategies(): Promise<SavedListResult> {
  try {
    const client = await signedInClient();
    if (!client) return { ok: false, reason: "signed-out" };
    const response = await client.listSavedStrategies({});
    return {
      ok: true,
      strategies: response.strategies.map((s) => savedOf(s as SavedInput)),
      limit: typeof response.limit === "number" ? response.limit : SAVED_STRATEGY_LIMIT,
    };
  } catch (err) {
    console.warn("[listSavedStrategies] unavailable:", err);
    return { ok: false, reason: "unavailable" };
  }
}

/** Save a strategy. Saving one already saved succeeds. */
export async function saveStrategy(strategyRef: string): Promise<SaveResult> {
  if (!validRef(strategyRef)) return { ok: false, reason: "not-found" };
  try {
    const client = await signedInClient();
    if (!client) return { ok: false, reason: "signed-out" };
    const response = await client.saveStrategy({ strategyRef: strategyRef.trim() });
    return { ok: true, strategy: savedOf(response.saved as SavedInput) };
  } catch (err) {
    // The cap is PermissionDenied with X-Entitlement-Detail naming cap_reached. The
    // code alone is not the signal: another refusal carries its own capability.
    if (parseEntitlementDetail(err)?.capability === CAP_REACHED) return { ok: false, reason: "limit" };
    if (connectCode(err) === CODE_NOT_FOUND) return { ok: false, reason: "not-found" };
    console.warn("[saveStrategy] unavailable:", err);
    return { ok: false, reason: "unavailable" };
  }
}

/** Remove a strategy from the signed-in user's list. Removing one not saved succeeds. */
export async function unsaveStrategy(strategyRef: string): Promise<UnsaveResult> {
  if (!validRef(strategyRef)) return { ok: false, reason: "unavailable" };
  try {
    const client = await signedInClient();
    if (!client) return { ok: false, reason: "signed-out" };
    await client.unsaveStrategy({ strategyRef: strategyRef.trim() });
    return { ok: true };
  } catch (err) {
    console.warn("[unsaveStrategy] unavailable:", err);
    return { ok: false, reason: "unavailable" };
  }
}
