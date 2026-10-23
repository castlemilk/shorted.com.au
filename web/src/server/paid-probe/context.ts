import {
  PAID_PROBE_USER_AGENT,
  PRODUCTION_APP_ORIGINS,
  PUBLIC_API_ORIGIN,
} from "./constants";
import { mintProbeSessionCookie } from "./session-cookie";
import { ProbeFailure, type ProbeContext, type ProbeEnv, type Trust } from "./types";

const UNTRUSTED_BASE_URL = "untrusted base URL";
const UNTRUSTED_PUBLIC_API_URL = "untrusted public API URL";

/** Vercel's deployment-protection bypass header. warm-cache sends the same one. */
export const VERCEL_BYPASS_HEADER = "x-vercel-protection-bypass";

/**
 * A bare DNS hostname: dot-separated labels of letters, digits and hyphens. No
 * scheme, path, query, port, credentials or whitespace, and no trailing dot.
 */
const BARE_HOSTNAME =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i;

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

/**
 * Adds Vercel's deployment-protection bypass to requests for the deployment's own
 * origin, and to no other request. The probe calls the deployment directly
 * because the apex is challenged by Cloudflare, and a protected deployment needs
 * this header to answer. Matching on the origin, not on the caller, is what keeps
 * the secret from reaching the apex or the public API. Every probe call sets
 * redirect: "manual", so the header cannot follow a redirect elsewhere.
 */
export function withDeploymentBypass(
  base: typeof fetch,
  deployment: string | undefined,
  secret: string | undefined,
): typeof fetch {
  if (!deployment || !secret) return base;
  return (input, init) => {
    if (parseOrigin(requestHref(input))?.origin !== deployment) return base(input, init);
    const headers = new Headers(init?.headers);
    headers.set(VERCEL_BYPASS_HEADER, secret);
    return base(input, { ...init, headers });
  };
}

function requestHref(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

/** Build the real context. Tests build their own; nothing else should. */
export function buildProbeContext(
  env: ProbeEnv,
  target: { requestUrl: string; shortsApiUrl: string },
  now: () => number = Date.now,
): ProbeContext {
  // Values are used raw, the same way the Go API compares the internal secret
  // against its own environment. Trimming here would make a correct value fail.
  // The Vercel bypass joins the list, so it is scrubbed from every detail too.
  const secrets = [
    env.INTERNAL_SERVICE_SECRET,
    env.NEXTAUTH_SECRET,
    env.PAID_PROBE_TOKEN,
    env.VERCEL_AUTOMATION_BYPASS_SECRET,
  ].filter((value): value is string => typeof value === "string" && value.trim() !== "");
  const deployment = deploymentOrigin(env);
  const bypassSecret = env.VERCEL_AUTOMATION_BYPASS_SECRET?.trim()
    ? env.VERCEL_AUTOMATION_BYPASS_SECRET
    : undefined;
  return {
    origin: resolveProbeOrigin(target.requestUrl, env),
    deploymentOrigin: deployment,
    publicApiOrigin: resolvePublicApiOrigin(env),
    shortsApiUrl: target.shortsApiUrl,
    internalSecret: env.INTERNAL_SERVICE_SECRET ?? "",
    fetch: withDeploymentBypass(probeFetch(), deployment, bypassSecret),
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
 *   fails; it does not fall back to anything else.
 * - On Vercel, the deployment's own URL (VERCEL_URL) is next. Cloudflare's bot
 *   challenge answers Vercel's egress on the apex with a 403 "Just a moment..."
 *   page, so a probe that calls shorted.com.au never reaches the app (2026-10-23).
 *   The deployment URL is the app itself. The platform sets VERCEL_URL and a
 *   caller cannot, so the Host header plays no part. A malformed value is not used.
 * - Otherwise, the origin the probe was called on. In production that origin is
 *   trusted only when it is one of the known app hosts, because the Host header
 *   is not ours to choose.
 * - Plain http is allowed only under NODE_ENV=development.
 */
export function resolveProbeOrigin(requestUrl: string, env: ProbeEnv): Trust<string> {
  const untrusted: Trust<string> = { trusted: false, reason: UNTRUSTED_BASE_URL };
  const configuredText = env.PAID_PROBE_BASE_URL?.trim();
  const configured = parseOrigin(configuredText);
  if (configuredText && !configured) return untrusted;
  if (configured) {
    return transportAllowed(configured, env) ? { trusted: true, value: configured.origin } : untrusted;
  }

  const deployment = deploymentOrigin(env);
  if (deployment) return { trusted: true, value: deployment };

  const candidate = parseOrigin(requestUrl);
  if (!candidate || !transportAllowed(candidate, env)) return untrusted;
  if (isProductionEnv(env) && !productionOrigins(env).has(candidate.origin)) return untrusted;
  return { trusted: true, value: candidate.origin };
}

/**
 * The deployment's own origin from VERCEL_URL, or undefined when it is unset or
 * is not a bare DNS hostname. Vercel sets it to the deployment's own host, so the
 * value needs no scheme, path, port or credentials. Anything else is not used.
 */
export function deploymentOrigin(env: ProbeEnv): string | undefined {
  const host = env.VERCEL_URL;
  if (typeof host !== "string" || !BARE_HOSTNAME.test(host)) return undefined;
  const lower = host.toLowerCase();
  return isDnsName(lower) ? `https://${lower}` : undefined;
}

/**
 * A DNS name, not an IP literal or a numeric shorthand. A name needs two or more
 * labels, and its last label is never all digits or 0x-hex (that is how the URL
 * parser reads an IPv4 address). The parser must also hand the name back
 * unchanged, so the origin stored here is the origin a request to it reaches.
 */
function isDnsName(host: string): boolean {
  const labels = host.split(".");
  if (labels.length < 2) return false;
  if (/^(?:\d+|0x[0-9a-f]*)$/.test(labels[labels.length - 1] ?? "")) return false;
  try {
    return new URL(`https://${host}`).hostname === host;
  } catch {
    return false;
  }
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
