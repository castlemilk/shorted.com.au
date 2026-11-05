// A refused strategy call carries its reason in the X-Entitlement-Detail
// error metadata: compact JSON, the same way X-RateLimit-Detail carries a
// quota refusal. This reads it from any Connect-shaped error. It imports
// nothing from @connectrpc, because a client module that does breaks the
// server render (CLAUDE.md, "SSR Issues with @connectrpc/connect").

const DETAIL_HEADER = "X-Entitlement-Detail";

export interface EntitlementDetail {
  /** What is refused, e.g. "full_signal_list" or "strategy_alerts". */
  capability: string;
  /** The access that lifts the refusal, e.g. "free" or "premium". */
  required: string;
  current: string | null;
  /** The rpc that serves the full answer, when the refusal names one. */
  rpc: string | null;
  /** The ceiling that fired, when the refusal names one. */
  limit: number | null;
  upgradeUrl: string | null;
  message: string | null;
}

interface MetadataLike {
  get(key: string): string | null | undefined;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * The entitlement detail on a refused call, or null when the error carries
 * none (a network failure, or a refusal from another layer).
 */
export function parseEntitlementDetail(error: unknown): EntitlementDetail | null {
  if (!error || typeof error !== "object") return null;
  const metadata = (error as { metadata?: unknown }).metadata as MetadataLike | undefined;
  if (!metadata || typeof metadata.get !== "function") return null;

  const raw = metadata.get(DETAIL_HEADER);
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const body = parsed as Record<string, unknown>;
  const capability = text(body.capability);
  const required = text(body.required);
  if (!capability || !required) return null;

  return {
    capability,
    required,
    current: text(body.current),
    rpc: text(body.rpc),
    limit: typeof body.limit === "number" && Number.isFinite(body.limit) ? body.limit : null,
    upgradeUrl: text(body.upgrade_url),
    message: text(body.message),
  };
}
