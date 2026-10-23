import { PAID_PROBE_USER_AGENT } from "./constants";
import { mintProbeSessionCookie } from "./session-cookie";
import { ProbeFailure, type ProbeContext } from "./types";

/**
 * The probe's fetch. It sets the probe UA and the no-store cache mode, and
 * nothing else.
 *
 * It deliberately never reads the Cloudflare SSR or testing bypass secrets, and
 * never adds `shorted-web-ssr` or `Shorted-E2E`. Those markers exist for our
 * own SSR and E2E traffic. A probe that carried them would be measuring a
 * different bucket from the one a paying customer hits. serverFetchWithUserAgent
 * is the app's fetcher and the one place those headers get attached, so the
 * probe does not use it.
 */
export function probeFetch(base: typeof fetch = fetch): typeof fetch {
  return (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set("user-agent", PAID_PROBE_USER_AGENT);
    return base(input, { ...init, headers, cache: "no-store" });
  };
}

/** Build the real context. Tests build their own; nothing else should. */
export function buildProbeContext(
  env: NodeJS.ProcessEnv,
  target: { origin: string; shortsApiUrl: string },
  now: () => number = Date.now,
): ProbeContext {
  // Values are used raw, the same way the Go API compares the internal secret
  // against its own environment. Trimming here would make a correct value fail.
  const secrets = [env.INTERNAL_SERVICE_SECRET, env.NEXTAUTH_SECRET, env.PAID_PROBE_TOKEN].filter(
    (value): value is string => typeof value === "string" && value.trim() !== "",
  );
  return {
    origin: target.origin,
    shortsApiUrl: target.shortsApiUrl,
    internalSecret: env.INTERNAL_SERVICE_SECRET ?? "",
    fetch: probeFetch(),
    sessionCookie: async () => {
      const secret = env.NEXTAUTH_SECRET;
      if (!secret) throw new ProbeFailure("NEXTAUTH_SECRET is not configured");
      return mintProbeSessionCookie({ secret, nodeEnv: env.NODE_ENV });
    },
    now,
    secrets,
  };
}

/**
 * The origin the chat and gate calls go to: PAID_PROBE_BASE_URL when it is a
 * usable http(s) URL, otherwise the origin the probe itself was called on.
 */
export function resolveProbeOrigin(requestUrl: string, configured: string | undefined): string {
  const candidate = configured?.trim();
  if (candidate) {
    try {
      const url = new URL(candidate);
      if (url.protocol === "https:" || url.protocol === "http:") return url.origin;
    } catch {
      // Fall through to the request's own origin.
    }
  }
  return new URL(requestUrl).origin;
}
