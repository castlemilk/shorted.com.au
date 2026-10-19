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

/** True only for a request Discord signed with this application's key. */
export function verifyDiscordRequest({
  body,
  signature,
  timestamp,
  publicKey: hex,
}: SignedRequest): boolean {
  if (!signature || !timestamp || !/^[0-9a-f]{128}$/i.test(signature)) {
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
