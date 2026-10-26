/**
 * The shared secret the Go API checks on every internal call (INTERNAL_SERVICE_SECRET).
 *
 * Read it through this function, and never from another variable. A fallback in
 * production sends a secret the API refuses, so the admin pages fail closed and nothing
 * points at the cause. The development fallback applies to `next dev` only. Anywhere
 * else an unset secret is a configuration error, so this throws rather than sending
 * an empty or wrong one.
 */
const DEVELOPMENT_SECRET = "dev-internal-secret";

export function internalServiceSecret(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const value = env.INTERNAL_SERVICE_SECRET;
  if (value) return value;
  if (env.NODE_ENV === "development") return DEVELOPMENT_SECRET;
  throw new Error("INTERNAL_SERVICE_SECRET is not configured");
}
