import { createPublicKey, verify, type KeyObject } from "node:crypto";

/**
 * Discord signs every interaction it POSTs with the application's Ed25519
 * key: `X-Signature-Ed25519` is the signature of `X-Signature-Timestamp`
 * followed by the raw body. An endpoint that does not check it answers to
 * anyone, and Discord tests for that: saving the endpoint URL in the
 * developer portal sends a badly signed request and refuses the URL unless
 * it gets a 401.
 *
 * The portal shows the public key as 64 hex characters (the raw 32-byte
 * key); node:crypto takes it as a JWK.
 */

const keys = new Map<string, KeyObject>();

function publicKey(hex: string): KeyObject {
  const cached = keys.get(hex);
  if (cached) return cached;
  const raw = Buffer.from(hex, "hex");
  if (raw.length !== 32) {
    throw new Error(
      "DISCORD_PUBLIC_KEY must be the 64-hex-character Ed25519 key",
    );
  }
  const key = createPublicKey({
    key: { kty: "OKP", crv: "Ed25519", x: raw.toString("base64url") },
    format: "jwk",
  });
  keys.set(hex, key);
  return key;
}

export interface SignedRequest {
  /** The request body exactly as received, before any JSON parsing. */
  body: string;
  signature: string | null;
  timestamp: string | null;
  /** The application's public key, hex. */
  publicKey: string;
}

/**
 * A Unix timestamp in seconds, digits only. Interactions and the Activity's
 * proxy (below) are signed with the SAME key and send the SAME header names,
 * but sign different messages: the timestamp then the body, and a JSON payload.
 * A proxy payload starts with "{", so a timestamp of digits can never be a
 * prefix of one, and a proxy signature can never pass as an interaction's.
 */
const TIMESTAMP = /^\d{1,20}$/;

/** True only for a request Discord signed with this application's key. */
export function verifyDiscordRequest({
  body,
  signature,
  timestamp,
  publicKey: hex,
}: SignedRequest): boolean {
  if (
    !signature ||
    !timestamp ||
    !TIMESTAMP.test(timestamp) ||
    !/^[0-9a-f]{128}$/i.test(signature)
  ) {
    return false;
  }
  try {
    return verify(
      null,
      Buffer.from(timestamp + body, "utf8"),
      publicKey(hex.trim()),
      Buffer.from(signature, "hex"),
    );
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// The Activity's proxy authentication (docs/discord-bot.md, "Proxy
// authentication"). With it on in the developer portal, Discord's proxy adds
// three headers to the requests it forwards from the Activity:
//
//   X-Discord-Proxy-Payload  base64 JSON: who, and created_at / expires_at
//   X-Signature-Ed25519      the application key's signature of those bytes
//   X-Signature-Timestamp    created_at, again
//
// The signature covers the payload and nothing else: not the path, the method
// or the body. A valid set is a short-lived pass for "a Discord user in this
// app's Activity", which anyone holding it could replay on any path until it
// expires, so it identifies a session; it never authorises a write by itself.
// ---------------------------------------------------------------------------

/** Why a request's proxy headers were not accepted. */
export type ProxyAuthFailure =
  /** None of the three headers: not proxied, or proxy authentication off. */
  | "missing"
  /** Some headers missing, or not in the shape Discord sends. */
  | "malformed"
  | "bad_signature"
  /** Signed, but the payload is not the JSON object Discord signs. */
  | "bad_payload"
  | "timestamp_mismatch"
  | "expired"
  | "not_yet_valid";

export type ProxyAuthResult =
  | {
      ok: true;
      /** The signed payload, parsed: trust it only through this result. */
      payload: Record<string, unknown>;
      createdAt: number;
      expiresAt: number;
    }
  | { ok: false; reason: ProxyAuthFailure };

export interface ProxyRequest {
  payload: string | null;
  signature: string | null;
  timestamp: string | null;
  /** The application's public key, hex. */
  publicKey: string;
  /** Seconds since the epoch. */
  now: number;
}

/** A base64 payload this long is far past anything Discord sends. */
const MAX_PAYLOAD_CHARS = 8192;
/** How far ahead of our clock a payload's `created_at` may be. */
const CLOCK_SKEW_S = 60;
const BASE64 = /^[A-Za-z0-9+/_-]+={0,2}$/;

/**
 * Discord's two samples disagree on the signature's encoding (hex in one,
 * base64 in the other), so take either, and nothing that is not 64 bytes.
 */
function signatureBytes(signature: string): Buffer | null {
  if (/^[0-9a-f]{128}$/i.test(signature)) return Buffer.from(signature, "hex");
  if (!BASE64.test(signature)) return null;
  const bytes = Buffer.from(signature, "base64");
  return bytes.length === 64 ? bytes : null;
}

const isSeconds = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v > 0;

/**
 * Checks the proxy headers in the order that makes each step mean something:
 * the signature over the payload's exact bytes first, and only then the JSON
 * and the times inside it (fields read before the signature are an
 * attacker's). Never throws.
 */
export function verifyDiscordProxyRequest({
  payload,
  signature,
  timestamp,
  publicKey: hex,
  now,
}: ProxyRequest): ProxyAuthResult {
  if (!payload && !signature && !timestamp) {
    return { ok: false, reason: "missing" };
  }
  if (
    !payload ||
    !signature ||
    !timestamp ||
    payload.length > MAX_PAYLOAD_CHARS ||
    !BASE64.test(payload) ||
    !TIMESTAMP.test(timestamp)
  ) {
    return { ok: false, reason: "malformed" };
  }
  const sig = signatureBytes(signature);
  if (!sig) return { ok: false, reason: "malformed" };

  const bytes = Buffer.from(payload, "base64");
  let verified = false;
  try {
    verified = verify(null, bytes, publicKey(hex.trim()), sig);
  } catch {
    verified = false;
  }
  if (!verified) return { ok: false, reason: "bad_signature" };

  let data: unknown;
  try {
    data = JSON.parse(bytes.toString("utf8"));
  } catch {
    return { ok: false, reason: "bad_payload" };
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { ok: false, reason: "bad_payload" };
  }
  const fields = data as Record<string, unknown>;
  const createdAt = fields.created_at;
  const expiresAt = fields.expires_at;
  if (!isSeconds(createdAt) || !isSeconds(expiresAt)) {
    return { ok: false, reason: "bad_payload" };
  }
  if (String(createdAt) !== timestamp) {
    return { ok: false, reason: "timestamp_mismatch" };
  }
  if (expiresAt < now) return { ok: false, reason: "expired" };
  if (createdAt > now + CLOCK_SKEW_S) {
    return { ok: false, reason: "not_yet_valid" };
  }
  return { ok: true, payload: fields, createdAt, expiresAt };
}
