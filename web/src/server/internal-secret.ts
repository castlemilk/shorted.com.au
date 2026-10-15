import { createHash, timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";

/**
 * Server-to-server authentication for /api/internal/* routes: the caller
 * presents INTERNAL_SERVICE_SECRET as `x-internal-secret` or a Bearer token.
 * Fails closed when the secret is not configured.
 */
export function hasInternalSecret(request: NextRequest): boolean {
  const expected = process.env.INTERNAL_SERVICE_SECRET;
  const provided = presentedSecret(request);
  if (!expected || !provided) return false;
  // Hash to fixed-size buffers so length differences do not leak or throw.
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

function presentedSecret(request: NextRequest): string | null {
  const header = request.headers.get("x-internal-secret");
  if (header) return header;
  const auth = request.headers.get("authorization");
  return auth?.startsWith("Bearer ") ? auth.slice("Bearer ".length) : null;
}
