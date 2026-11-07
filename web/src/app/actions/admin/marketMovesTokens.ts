"use server";

import { revalidatePath } from "next/cache";
import { SERVER_SHORTS_API_URL } from "~/app/actions/config";
import { requireAdmin } from "~/server/admin";
import { internalServiceSecret } from "~/server/internal-service-secret";
import {
  DEFAULT_TOKEN_EXPIRY_DAYS,
  TOKEN_EXPIRY_CHOICES,
} from "~/@/lib/market-moves/tokens";

// The admin console's market-moves tokens (/admin/market-moves): the credentials
// a market-moves workflow posts to POST /v1/market-moves with
// (docs/feature/market-moves/README.md, services/shorts/internal/services/
// shorts/market_moves_tokens.go).
//
// Every action gates IN the action with requireAdmin(): server actions are
// addressable by action id, so the /admin page is not the boundary. The
// INTERNAL_SERVICE_SECRET never leaves the server, and x-admin-actor (the
// verified admin's address) is a label for the API's audit log, never
// authorisation. No retries: create and revoke are mutations.
//
// A created token is returned to the console ONCE. The API keeps only its hash,
// so neither this module nor the API can show it again.

/** A token as the console lists it. Never the token itself. */
export interface MarketMovesToken {
  id: number;
  name: string;
  prefix: string;
  status: "active" | "expired" | "revoked";
  createdBy: string;
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  revokedBy: string | null;
}

export interface MarketMovesTokenList {
  ok: boolean;
  tokens: MarketMovesToken[];
  maxActive: number;
  error?: string;
}

export type MarketMovesTokenResult =
  | { ok: true; token: MarketMovesToken; secret?: string }
  | { ok: false; error: string; fields?: { field: string; message: string }[] };

interface TokenWire {
  id: number;
  name: string;
  prefix: string;
  status: string;
  created_by: string;
  created_at: string;
  expires_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
  revoked_by?: string;
}

interface ErrorWire {
  error?: string;
  message?: string;
  fields?: { field: string; message: string }[];
}

function fromWire(t: TokenWire): MarketMovesToken {
  const status = t.status === "revoked" || t.status === "expired" ? t.status : "active";
  return {
    id: t.id,
    name: t.name,
    prefix: t.prefix,
    status,
    createdBy: t.created_by,
    createdAt: t.created_at,
    expiresAt: t.expires_at ?? null,
    lastUsedAt: t.last_used_at ?? null,
    revokedAt: t.revoked_at ?? null,
    revokedBy: t.revoked_by ? t.revoked_by : null,
  };
}

async function callTokensApi(
  path: string,
  actor: string,
  init: { method: "GET" | "POST"; body?: unknown },
): Promise<{ status: number; body: unknown }> {
  const secret = internalServiceSecret();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(`${SERVER_SHORTS_API_URL}${path}`, {
      method: init.method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${secret}`,
        "x-internal-secret": secret,
        "x-admin-actor": actor,
        "User-Agent": "Mozilla/5.0 (compatible; ShortedAdmin)",
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      cache: "no-store",
      signal: controller.signal,
    });
    const body: unknown = await response.json().catch(() => ({}));
    return { status: response.status, body };
  } finally {
    clearTimeout(timer);
  }
}

function messageOf(status: number, body: unknown): string {
  const e = (body ?? {}) as ErrorWire;
  return e.message ?? `The API answered HTTP ${status}`;
}

function errorOf(status: number, body: unknown): MarketMovesTokenResult {
  const e = (body ?? {}) as ErrorWire;
  return {
    ok: false,
    error: messageOf(status, body),
    fields: Array.isArray(e.fields) ? e.fields : undefined,
  };
}

/** Every token, usable ones first. */
export async function listMarketMovesTokens(): Promise<MarketMovesTokenList> {
  const admin = await requireAdmin();
  try {
    const { status, body } = await callTokensApi("/api/admin/market-moves/tokens", admin.email, { method: "GET" });
    if (status !== 200) {
      return { ok: false, tokens: [], maxActive: 0, error: messageOf(status, body) };
    }
    const data = body as { tokens?: TokenWire[]; max_active?: number };
    return {
      ok: true,
      tokens: Array.isArray(data.tokens) ? data.tokens.map(fromWire) : [],
      maxActive: typeof data.max_active === "number" ? data.max_active : 0,
    };
  } catch (err) {
    console.error("[market moves] list tokens failed:", err);
    return { ok: false, tokens: [], maxActive: 0, error: "The API could not be reached" };
  }
}

/**
 * Create a token. The answer's `secret` is the token: shown once, never stored
 * here, never logged.
 */
export async function createMarketMovesToken(input: {
  name: string;
  expiresInDays: number;
}): Promise<MarketMovesTokenResult> {
  const admin = await requireAdmin();
  const expiresInDays = (TOKEN_EXPIRY_CHOICES as readonly number[]).includes(input.expiresInDays)
    ? input.expiresInDays
    : DEFAULT_TOKEN_EXPIRY_DAYS;
  try {
    const { status, body } = await callTokensApi("/api/admin/market-moves/tokens", admin.email, {
      method: "POST",
      body: { name: input.name, expires_in_days: expiresInDays },
    });
    if (status !== 201) return errorOf(status, body);
    const data = body as { token?: string; meta?: TokenWire };
    if (!data.token || !data.meta) return { ok: false, error: "The API answered without a token" };
    revalidatePath("/admin/market-moves");
    return { ok: true, token: fromWire(data.meta), secret: data.token };
  } catch (err) {
    console.error("[market moves] create token failed:", err instanceof Error ? err.message : "unknown error");
    return { ok: false, error: "The API could not be reached; no token was created" };
  }
}

/** Revoke a token. Every API instance refuses it within 30 seconds. */
export async function revokeMarketMovesToken(id: number): Promise<MarketMovesTokenResult> {
  const admin = await requireAdmin();
  if (!Number.isInteger(id) || id <= 0) return { ok: false, error: "That is not a token id" };
  try {
    const { status, body } = await callTokensApi("/api/admin/market-moves/tokens/revoke", admin.email, {
      method: "POST",
      body: { id },
    });
    if (status !== 200) return errorOf(status, body);
    const data = body as { meta?: TokenWire };
    if (!data.meta) return { ok: false, error: "The API answered without the token" };
    revalidatePath("/admin/market-moves");
    return { ok: true, token: fromWire(data.meta) };
  } catch (err) {
    console.error("[market moves] revoke token failed:", err);
    return { ok: false, error: "The API could not be reached; the token was not revoked" };
  }
}
