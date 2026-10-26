import { CHECKIN_BUDGET_MS, PAID_PROBE_USER_AGENT } from "./constants";
import type { PaidProbeRun, ProbeStepName } from "./steps";
import { errorName, type ProbeEnv } from "./types";

/**
 * Telesis check-ins for the probe. The protocol is the one the Go cron reporter
 * speaks (services/jobs/internal/jobs/cronreporter/checkin.go): POST
 * `<private url>/complete` or `/fail` with `{duration_ms, terminal_reason}`.
 *
 * The private URL is the credential, so it is never logged. A check-in that is
 * refused or unusable is NOT silent: the route answers non-200 for it (see
 * app/api/internal/paid-probe/route.ts), so Vercel's function log shows the run
 * as failed. A warning alone let a broken map stay quiet.
 */

export type CheckinKey = ProbeStepName | "all";

export const CHECKIN_KEYS: readonly CheckinKey[] = ["entitlement", "chat", "api_token", "gates", "all"];

export type CheckinUrls = Partial<Record<CheckinKey, string>>;

/**
 * "disabled": the variable is unset, so nothing is configured to send.
 * "invalid": the variable is set but unusable, so nothing was sent. The route
 *   treats this as a failure, not as "disabled", so a broken map cannot go quiet.
 * "partial": at least one POST was refused or failed.
 */
export type CheckinStatus = "disabled" | "invalid" | "sent" | "partial";

/** The only host a private check-in URL may point at. A wrong host would receive the credential. */
export const TELESIS_CHECKIN_HOST = "api.telesis.dev";
const TELESIS_CHECKIN_PATH_PREFIX = "/v1/cron/";
const TERMINAL_REASON_MAX_BYTES = 1024;

let warnedInvalidConfig = false;

/**
 * Parse TELESIS_PAID_PROBE_CHECKINS: a JSON object from check-in key to private
 * URL. All or nothing: one unknown key or one bad URL disables the lot, so a
 * typo cannot silently drop a single step's check-in while the others report.
 * Returns undefined when the variable is absent or unusable.
 */
export function parseCheckinConfig(raw: string | undefined): CheckinUrls | undefined {
  const text = raw?.trim();
  if (!text) return undefined;

  const urls = parseMap(text);
  if (!urls || Object.keys(urls).length === 0) {
    warnInvalidConfig();
    return undefined;
  }
  for (const [key, value] of Object.entries(urls)) {
    if (!(CHECKIN_KEYS as readonly string[]).includes(key) || !isTelesisCheckinURL(value)) {
      warnInvalidConfig();
      return undefined;
    }
  }
  return urls as CheckinUrls;
}

function parseMap(text: string): Record<string, string> | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value !== "string") return undefined;
      out[key] = value;
    }
    return out;
  } catch {
    return undefined;
  }
}

/** Exported for the tests. Accepts only an https URL on the Telesis host with a cron token path. */
export function isTelesisCheckinURL(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    url.protocol === "https:" &&
    url.hostname === TELESIS_CHECKIN_HOST &&
    url.username === "" &&
    url.password === "" &&
    url.search === "" &&
    url.hash === "" &&
    url.pathname.startsWith(TELESIS_CHECKIN_PATH_PREFIX) &&
    url.pathname.length > TELESIS_CHECKIN_PATH_PREFIX.length
  );
}

function warnInvalidConfig(): void {
  // Logged once per instance, and the message says nothing about the content.
  if (warnedInvalidConfig) return;
  warnedInvalidConfig = true;
  console.warn("[paid-probe] TELESIS_PAID_PROBE_CHECKINS is not a valid check-in map; check-ins are disabled");
}

/**
 * Send every configured check-in for a finished run, in parallel so the total
 * wait is one timeout, not one per key. Returns "sent" only when every POST
 * was accepted.
 */
export async function sendCheckins(
  urls: CheckinUrls,
  run: PaidProbeRun,
  fetchImpl: typeof fetch = fetch,
): Promise<CheckinStatus> {
  const posts: Promise<boolean>[] = [];
  for (const step of run.steps) {
    const url = urls[step.name];
    if (url) {
      posts.push(postCheckin(fetchImpl, step.name, url, step.ok, step.durationMs, step.detail));
    }
  }
  if (urls.all) {
    posts.push(postCheckin(fetchImpl, "all", urls.all, run.ok, run.durationMs, overallReason(run)));
  }
  const results = await Promise.all(posts);
  return results.every(Boolean) ? "sent" : "partial";
}

/**
 * POST one check-in to a private Telesis cron URL: `/complete` when ok, `/fail`
 * otherwise. Resolves to whether Telesis accepted it. Never rejects, and never
 * logs the URL. Shared with the Stripe reconcile heartbeat.
 */
export async function postCheckin(
  fetchImpl: typeof fetch,
  label: string,
  checkinURL: string,
  ok: boolean,
  durationMs: number,
  reason: string,
): Promise<boolean> {
  // The URL is built here and never passed to a log call, even on error: a
  // TypeError from fetch can carry it in its message, so only the error name is logged.
  const endpoint = `${checkinURL.replace(/\/+$/, "")}/${ok ? "complete" : "fail"}`;
  try {
    const res = await fetchImpl(endpoint, {
      method: "POST",
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(CHECKIN_BUDGET_MS),
      headers: {
        "content-type": "application/json",
        "user-agent": PAID_PROBE_USER_AGENT,
      },
      body: JSON.stringify({
        duration_ms: Math.max(0, Math.round(durationMs)),
        terminal_reason: truncateBytes(reason, TERMINAL_REASON_MAX_BYTES),
      }),
    });
    await res.text().catch(() => "");
    if (!res.ok) {
      console.warn(`[telesis-checkin] check-in ${label} answered HTTP ${res.status}`);
      return false;
    }
    return true;
  } catch (err) {
    console.warn(`[telesis-checkin] check-in ${label} failed: ${errorName(err)}`);
    return false;
  }
}

function overallReason(run: PaidProbeRun): string {
  if (run.ok) {
    return `${run.steps.length}/${run.steps.length} steps passed`;
  }
  const failed = run.steps.filter((step) => !step.ok).map((step) => step.name);
  return `failed: ${failed.join(", ")}`;
}

/** Cut to at most `max` UTF-8 bytes without splitting a character. */
function truncateBytes(text: string, max: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(text).length <= max) return text;
  let out = text;
  while (out.length > 0 && encoder.encode(out).length > max) {
    out = out.slice(0, -1);
  }
  return out;
}

/**
 * Entry point for the route: parse the environment, and when it is usable send
 * the check-ins for a finished run. "disabled" means nothing was sent.
 */
export async function reportCheckins(
  run: PaidProbeRun,
  env: ProbeEnv,
  fetchImpl: typeof fetch = fetch,
): Promise<CheckinStatus> {
  const raw = env.TELESIS_PAID_PROBE_CHECKINS;
  if (!raw?.trim()) return "disabled";
  const urls = parseCheckinConfig(raw);
  if (!urls) return "invalid";
  return sendCheckins(urls, run, fetchImpl);
}
