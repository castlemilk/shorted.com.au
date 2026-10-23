import {
  PAID_PROBE_USER_AGENT,
  PRODUCTION_APP_ORIGINS,
  PUBLIC_API_ORIGIN,
} from "./constants";
import { mintProbeSessionCookie } from "./session-cookie";
import { ProbeFailure, type ProbeContext, type ProbeEnv, type Trust } from "./types";

const UNTRUSTED_BASE_URL = "untrusted base URL";
const UNTRUSTED_PUBLIC_API_URL = "untrusted public API URL";

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
  env: ProbeEnv,
  target: { requestUrl: string; shortsApiUrl: string },
  now: () => number = Date.now,
): ProbeContext {
  // Values are used raw, the same way the Go API compares the internal secret
  // against its own environment. Trimming here would make a correct value fail.
  const secrets = [env.INTERNAL_SERVICE_SECRET, env.NEXTAUTH_SECRET, env.PAID_PROBE_TOKEN].filter(
    (value): value is string => typeof value === "string" && value.trim() !== "",
  );
  return {
    origin: resolveProbeOrigin(target.requestUrl, env),
    publicApiOrigin: resolvePublicApiOrigin(env),
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
 * Production as auth.ts defines it. On Vercel NODE_ENV is "production" for
 * preview deployments too, so VERCEL_ENV decides when it is set.
 */
export function isProductionEnv(env: ProbeEnv): boolean {
  return env.VERCEL_ENV === "production" || (env.NODE_ENV === "production" && !env.VERCEL_ENV);
}

/**
 * The origin the chat and gate calls go to. Only a known origin may receive the
 * probe's session cookie, so the choice is made here, once, and never from
 * anything a caller can shape.
 *
 * - PAID_PROBE_BASE_URL, when set, is the operator's word. If it is unusable it
 *   fails; it does not fall back to the request.
 * - Without it, the origin is the one the probe was called on. In production
 *   that origin is trusted only when it is one of the known app hosts, because
 *   the Host header is not ours to choose.
 * - Plain http is allowed only under NODE_ENV=development.
 */
export function resolveProbeOrigin(requestUrl: string, env: ProbeEnv): Trust<string> {
  const untrusted: Trust<string> = { trusted: false, reason: UNTRUSTED_BASE_URL };
  const configuredText = env.PAID_PROBE_BASE_URL?.trim();
  const configured = parseOrigin(configuredText);
  if (configuredText && !configured) return untrusted;

  const candidate = configured ?? parseOrigin(requestUrl);
  if (!candidate || !transportAllowed(candidate, env)) return untrusted;

  if (!configured && isProductionEnv(env) && !productionOrigins(env).has(candidate.origin)) {
    return untrusted;
  }
  return { trusted: true, value: candidate.origin };
}

/**
 * The public API origin the authenticated api_token read goes to. Its default
 * is the host paying customers use. In production that host is fixed: the probe
 * never sends a minted token anywhere else, however the variable is set.
 */
export function resolvePublicApiOrigin(env: ProbeEnv): Trust<string> {
  const untrusted: Trust<string> = { trusted: false, reason: UNTRUSTED_PUBLIC_API_URL };
  const configuredText = env.SHORTED_PUBLIC_API_URL?.trim();
  // A blank variable means the default; a configured value that does not parse is refused.
  const candidate = configuredText ? parseOrigin(configuredText) : parseOrigin(PUBLIC_API_ORIGIN);
  if (!candidate || !transportAllowed(candidate, env)) return untrusted;
  if (isProductionEnv(env) && candidate.origin !== PUBLIC_API_ORIGIN) return untrusted;
  return { trusted: true, value: candidate.origin };
}

/** The origin of an http(s) URL, or undefined for anything else. */
function parseOrigin(value: string | undefined): URL | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  return url;
}

/** https everywhere; plain http only for a local development server. */
function transportAllowed(url: URL, env: ProbeEnv): boolean {
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && env.NODE_ENV === "development";
}

/** The production hosts: the fixed list plus NEXTAUTH_URL's origin, when it parses. */
function productionOrigins(env: ProbeEnv): Set<string> {
  const origins = new Set(PRODUCTION_APP_ORIGINS);
  const nextAuth = parseOrigin(env.NEXTAUTH_URL);
  if (nextAuth) origins.add(nextAuth.origin);
  return origins;
}
