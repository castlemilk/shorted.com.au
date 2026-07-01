import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Email image proxy — shared signing contract.
 *
 * The digest builder (Go, in services/news-aggregator) signs each proxied
 * thumbnail URL; this route (Node) verifies it. The canonical message MUST be
 * byte-identical on both sides:
 *
 *     message = `${rawUrl}|${width}`
 *     sig     = hex(HMAC_SHA256(EMAIL_IMG_SECRET, message))
 *
 * `rawUrl` is the un-encoded upstream image URL (what URLSearchParams.get("u")
 * returns after decoding). `width` is the decimal display width string ("120").
 * Signing the width prevents a tampered `w` from driving arbitrary render sizes.
 *
 * A Go parity test (broadcast/... TestEmailImageSignatureParity) pins the same
 * vector so the two implementations can never silently drift.
 */
export function emailImageSignature(
  rawUrl: string,
  width: string,
  secret: string,
): string {
  return createHmac("sha256", secret).update(`${rawUrl}|${width}`).digest("hex");
}

export function verifyEmailImageSignature(
  rawUrl: string,
  width: string,
  sig: string,
  secret: string,
): boolean {
  if (!sig || !secret) return false;
  const expected = emailImageSignature(rawUrl, width, secret);
  // timingSafeEqual requires equal-length buffers.
  if (expected.length !== sig.length) return false;
  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
  } catch {
    return false;
  }
}

const PRIVATE_V4 =
  /^(0\.|10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/;

/**
 * isBlockedHost — defense-in-depth SSRF guard. The HMAC signature is the primary
 * control (only URLs we signed are ever fetched); this additionally rejects
 * hostnames/IP literals that point at private, loopback, link-local or
 * cloud-metadata addresses, so even a signed-but-hostile URL can't reach them.
 */
export function isBlockedHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!h) return true;
  if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal"))
    return true;
  if (h === "metadata" || h === "metadata.google.internal") return true;
  if (PRIVATE_V4.test(h)) return true;
  // IPv6 loopback / link-local (fe80::) / unique-local (fc00::/7 → fc.. or fd..)
  if (h === "::1" || h.startsWith("fe80:") || /^f[cd][0-9a-f]{2}:/.test(h))
    return true;
  // IPv4-mapped metadata address in any notation
  if (h === "169.254.169.254" || h.includes("169.254.169.254")) return true;
  return false;
}
