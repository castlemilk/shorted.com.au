import type { ProbeCookie } from "./session-cookie";

/**
 * The environment the probe reads. process.env satisfies it. A plain record, not
 * NodeJS.ProcessEnv, because Next augments that type with a required NODE_ENV,
 * which would make every partial environment in a test a type error.
 */
export type ProbeEnv = Readonly<Record<string, string | undefined>>;

/**
 * A value the probe will send anywhere, or the reason it refuses to. Trust is
 * decided once, when the context is built, and a step that needs an untrusted
 * value fails before it sends anything.
 */
export type Trust<T> = { trusted: true; value: T } | { trusted: false; reason: string };

/** The step failure detail for a value that is not trusted. */
export function requireTrusted<T>(trust: Trust<T>): T {
  if (!trust.trusted) throw new ProbeFailure(trust.reason);
  return trust.value;
}

/**
 * Everything a probe run touches from the outside, injected so the steps stay
 * testable with a fake fetch and a fake clock. The route builds the real one
 * (context.ts); tests build fakes.
 */
export interface ProbeContext {
  /** Origin of the app under test. Chat and gate requests go here, and only here. */
  origin: Trust<string>;
  /**
   * The deployment's own origin (VERCEL_URL), when the platform gives one. A step
   * whose origin is this one says "via deployment" in its detail, so the edge was
   * not in the path. Absent outside Vercel.
   */
  deploymentOrigin?: string;
  /**
   * Origin of the public API paying customers call (api.shorted.com.au by default).
   * The authenticated api_token read goes here, through the Cloudflare edge worker.
   */
  publicApiOrigin: Trust<string>;
  /** Base URL of the Go shorts API, server side. The internal calls go here. */
  shortsApiUrl: string;
  /** INTERNAL_SERVICE_SECRET, or "" when unset (the steps then fail closed). */
  internalSecret: string;
  /**
   * The probe's own fetch: plain UA and no-store. The one credential it may add
   * is Vercel's deployment-protection bypass, and only for the deployment origin
   * (see withDeploymentBypass).
   */
  fetch: typeof fetch;
  /** Mints the probe session cookie. Throws when NEXTAUTH_SECRET is unset. */
  sessionCookie: () => Promise<ProbeCookie>;
  now: () => number;
  /**
   * Values scrubbed from every detail string. It starts with the static
   * credentials and grows with each per-run credential a step mints (see remember).
   */
  secrets: string[];
}

/** Add a per-run credential to the scrub list, so no detail string can echo it. */
export function remember(ctx: ProbeContext, value: string): void {
  if (value.length > 0) ctx.secrets.push(value);
}

/**
 * A step failure with a reason that is safe to return to the caller and to
 * Telesis. Anything else thrown is described by its error name only, plus its
 * numeric Connect code when it has one. The message is never used: it can carry
 * a URL, a header or a credential.
 */
export class ProbeFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProbeFailure";
  }
}

/**
 * Name of an error for logs and details. Never the message: fetch errors can
 * carry a URL. Duck-typed rather than instanceof Error, because a DOMException
 * from another realm (a jest environment, a worker) is not an Error here.
 */
export function errorName(err: unknown): string {
  if (typeof err === "object" && err !== null && typeof (err as { name?: unknown }).name === "string") {
    return (err as { name: string }).name;
  }
  return "unknown";
}

/** Name, and the Connect code when present (ConnectError carries one as a number). */
export function unexpectedErrorDetail(err: unknown): string {
  const name = errorName(err);
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "number" ? `${name} code=${code}` : name;
}
