import { hasValidChatEntitlement } from "@/lib/chat-server-guards";

import {
  CHAT_TURN_BUDGET_MS,
  CHECKIN_BUDGET_MS,
  PAID_API_MONTHLY_LIMIT_MIN,
  PAID_PROBE_QUESTION,
  STEP_BUDGET_MS,
} from "./constants";
import type { ProbeCookie } from "./session-cookie";
import { getMySubscription, mintApiToken } from "./shorts-client";
import { ChatStreamParser, consumeChatStream, toolCallFailure } from "./sse";
import {
  errorName,
  ProbeFailure,
  remember,
  requireTrusted,
  unexpectedErrorDetail,
  type ProbeContext,
} from "./types";

export type ProbeStepName = "entitlement" | "chat" | "api_token" | "gates";

export const PROBE_STEP_NAMES: readonly ProbeStepName[] = [
  "entitlement",
  "chat",
  "api_token",
  "gates",
];

/**
 * Each step's budget, keyed by name. probeWorstCaseMs() sums this table, so a
 * step cannot be left out of the total.
 */
export const PROBE_STEP_BUDGETS: Readonly<Record<ProbeStepName, number>> = {
  entitlement: STEP_BUDGET_MS.entitlement,
  chat: STEP_BUDGET_MS.chat,
  api_token: STEP_BUDGET_MS.apiToken,
  gates: STEP_BUDGET_MS.gates,
};

/** Every step at its full budget, then the check-ins: the longest a run can take. */
export function probeWorstCaseMs(): number {
  return PROBE_STEP_NAMES.reduce((total, name) => total + PROBE_STEP_BUDGETS[name], 0) + CHECKIN_BUDGET_MS;
}

export interface ProbeStepResult {
  name: ProbeStepName;
  ok: boolean;
  durationMs: number;
  /** Short and free of secrets. On a pass it says what was proven; on a fail, why. */
  detail: string;
}

export interface PaidProbeRun {
  ok: boolean;
  startedAt: string;
  durationMs: number;
  steps: ProbeStepResult[];
}

interface StepDefinition {
  name: ProbeStepName;
  budgetMs: number;
  /**
   * The step calls the app under test (ctx.origin). Its detail then says which
   * origin was probed, so a failure read in Telesis shows whether the edge was in the path.
   */
  appOrigin?: true;
  /** Resolves with a detail on success; throws (ideally ProbeFailure) on failure. */
  run: (ctx: ProbeContext, signal: AbortSignal) => Promise<string>;
}

const STEPS: readonly StepDefinition[] = [
  { name: "entitlement", budgetMs: PROBE_STEP_BUDGETS.entitlement, run: checkEntitlement },
  { name: "chat", budgetMs: PROBE_STEP_BUDGETS.chat, appOrigin: true, run: checkChat },
  { name: "api_token", budgetMs: PROBE_STEP_BUDGETS.api_token, run: checkApiToken },
  { name: "gates", budgetMs: PROBE_STEP_BUDGETS.gates, appOrigin: true, run: checkGates },
];

const DETAIL_MAX_CHARS = 300;

/**
 * Run every step in order. Each one gets its own timeout and its failure is
 * recorded, not thrown, so a broken chat path still tells us the token path
 * works. The steps run one after another because they share one probe identity
 * and its per-user caps, and an ordered run reads like a timeline in the response.
 */
export async function runPaidProbe(ctx: ProbeContext): Promise<PaidProbeRun> {
  const started = ctx.now();
  const steps: ProbeStepResult[] = [];
  for (const step of STEPS) {
    steps.push(await runStep(step, ctx));
  }
  return {
    ok: steps.every((step) => step.ok),
    startedAt: new Date(started).toISOString(),
    durationMs: ctx.now() - started,
    steps,
  };
}

async function runStep(step: StepDefinition, ctx: ProbeContext): Promise<ProbeStepResult> {
  const started = ctx.now();
  const signal = AbortSignal.timeout(step.budgetMs);
  let ok = false;
  let detail: string;
  try {
    detail = await step.run(ctx, signal);
    ok = true;
  } catch (err) {
    detail = describeFailure(err, signal, step.budgetMs);
  }
  const via = step.appOrigin ? viaOrigin(ctx) : undefined;
  return {
    name: step.name,
    ok,
    durationMs: ctx.now() - started,
    detail: clip(scrub(via ? `${via}: ${detail}` : detail, ctx.secrets), DETAIL_MAX_CHARS),
  };
}

/**
 * Which origin an app step probed, host only: "via deployment <host>" when that is
 * the deployment itself, otherwise "via <host>". Nothing for an untrusted origin,
 * because the step's own reason ("untrusted base URL") already says why it did not run.
 */
function viaOrigin(ctx: ProbeContext): string | undefined {
  if (!ctx.origin.trusted) return undefined;
  const host = new URL(ctx.origin.value).host;
  return ctx.origin.value === ctx.deploymentOrigin ? `via deployment ${host}` : `via ${host}`;
}

function describeFailure(err: unknown, signal: AbortSignal, budgetMs: number): string {
  if (isTimeout(err, signal)) {
    return `timed out after ${Math.round(budgetMs / 1000)}s`;
  }
  if (err instanceof ProbeFailure) return err.message;
  return unexpectedErrorDetail(err);
}

/** A step timed out when our own budget fired, whether the fetch or the body read reported it. */
function isTimeout(err: unknown, signal: AbortSignal): boolean {
  if (errorName(err) === "TimeoutError") return true;
  return signal.aborted && errorName(signal.reason) === "TimeoutError";
}

/** Replace every configured or per-run secret that appears in a detail string. */
function scrub(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret) out = out.split(secret).join("[redacted]");
  }
  return out;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

/** Step 1: the Go API grants the probe identity a chat-eligible subscription. */
async function checkEntitlement(ctx: ProbeContext, signal: AbortSignal): Promise<string> {
  const info = await getMySubscription(ctx, signal);
  if (!hasValidChatEntitlement(info)) {
    throw new ProbeFailure(`no paid chat entitlement (status=${info.status}, tier=${info.tier})`);
  }
  return `status=${info.status} tier=${info.tier}`;
}

/**
 * Step 2: a real chat send, through the app's own /api/chat, as the probe user.
 * It exercises the gate, the Gemini call and the tool calls. It fails on the
 * chat-service's own tool error reports: on 2026-10-23 every tool failure
 * arrived inside an HTTP 200 chat response, which is why nothing alerted.
 *
 * The step is budgeted as a whole: the turn (request and stream) gets
 * CHAT_TURN_BUDGET_MS, and the conversation cleanup has the rest of the step.
 *
 * The conversation is removed whatever the outcome, including a timed-out turn:
 * its id is read from the stream as it arrives, not after it finishes.
 */
async function checkChat(ctx: ProbeContext): Promise<string> {
  // Trust is settled before anything is sent: an untrusted origin gets no cookie and no request.
  const origin = requireTrusted(ctx.origin);
  const cookie = await ctx.sessionCookie();
  remember(ctx, cookie.value);

  // The turn has its own timer, shorter than the step's, so the step's signal
  // could never fire first. The cleanup below also has its own timer.
  const turn = AbortSignal.timeout(CHAT_TURN_BUDGET_MS);
  const parser = new ChatStreamParser();
  let failure: unknown = null;
  try {
    const res = await ctx.fetch(`${origin}/api/chat`, {
      method: "POST",
      redirect: "manual",
      signal: turn,
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream",
        origin,
        cookie: cookieHeader(cookie),
      },
      body: JSON.stringify(chatRequestBody()),
    });
    if (res.status !== 200) {
      throw new ProbeFailure(`HTTP ${res.status}${await errorSuffix(res)}`);
    }
    await consumeChatStream(res.body, parser);
  } catch (err) {
    failure = err;
  }

  // Cleanup before judging, and before rethrowing a failure, so neither a failed
  // assertion nor a timeout leaves the conversation behind.
  const cleanup = await cleanUpConversation(ctx, origin, cookie, parser.knownConversationId());
  if (failure !== null) {
    // The turn's own limit is the one that fired, so name that, not the step's.
    throw isTimeout(failure, turn)
      ? new ProbeFailure(`timed out after ${CHAT_TURN_BUDGET_MS / 1000}s`)
      : failure;
  }

  const stream = parser.snapshot();
  if (stream.errors.length > 0) {
    throw new ProbeFailure(`stream error: ${stream.errors[0] ?? "unknown"}`);
  }
  if (!stream.done) throw new ProbeFailure("stream ended without [DONE]");
  if (stream.text.trim() === "") throw new ProbeFailure("no answer text");
  if (!stream.finalData) throw new ProbeFailure("no data-shorted-final part");

  const toolCalls = stream.finalData.toolCalls ?? [];
  if (toolCalls.length === 0) throw new ProbeFailure("no tool calls");
  for (const call of toolCalls) {
    const failure = toolCallFailure(call);
    if (failure) throw new ProbeFailure(`tool failed: ${failure}`);
  }

  const names = toolCalls.map((call) => call.toolName).join(",");
  return `tools=${names}; ${cleanup}`;
}

/**
 * Step 3: a bespoke API token minted for the probe identity is accepted by the
 * public read path, and it is metered as a PAID caller, not as an anonymous IP.
 *
 * MintToken is internal and goes to the server API. The authenticated read goes
 * to the public host, through the edge worker, the way a paying customer's does.
 */
async function checkApiToken(ctx: ProbeContext, signal: AbortSignal): Promise<string> {
  // Trust first: an untrusted public host is refused before any token exists.
  const publicOrigin = requireTrusted(ctx.publicApiOrigin);

  const token = await mintApiToken(ctx, signal);
  if (!token) throw new ProbeFailure("MintToken returned an empty token");
  remember(ctx, token);

  // The token is held in this closure only: never logged, never in a detail.
  const res = await ctx.fetch(`${publicOrigin}/shorts.v1alpha1.ShortedStocksService/GetStock`, {
    method: "POST",
    redirect: "manual",
    signal,
    headers: {
      "content-type": "application/json",
      // The edge worker treats any Connect request as pass-through (BYPASS), so
      // the answer is this token's own, never a cached one served to someone else.
      "connect-protocol-version": "1",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ productCode: "BHP" }),
  });
  const body = await res.text();
  if (res.status !== 200) {
    throw new ProbeFailure(`GetStock with the token answered HTTP ${res.status}`);
  }

  // The worker stamps every answer it passes through. Anything but BYPASS means
  // the answer came from the shared edge cache, whose headers are someone else's.
  const edgeCache = res.headers.get("x-shorted-cache");
  if (edgeCache !== "BYPASS") {
    throw new ProbeFailure(`answer was not passed through to origin (x-shorted-cache: ${edgeCache ?? "absent"})`);
  }
  if (!isJsonObject(body)) {
    throw new ProbeFailure("GetStock with the token returned no JSON object");
  }

  // The Go API emits the monthly header only for a metered tier. Free is 1,000
  // and anonymous 500, so a value at or above the paid floor is the proof. An
  // absent header (rate limiting off, or an anonymous fallback) fails here.
  const limitHeader = res.headers.get("x-ratelimit-monthly-limit");
  const monthly = limitHeader === null ? Number.NaN : Number(limitHeader);
  if (!Number.isInteger(monthly) || monthly < PAID_API_MONTHLY_LIMIT_MIN) {
    throw new ProbeFailure(
      `token is not on a paid API tier (monthly limit ${limitHeader ?? "absent"})`,
    );
  }
  return `GetStock 200 via the public API, monthly limit ${monthly}`;
}

/**
 * Step 4: paid features stay closed to anonymous callers. Both answers must be
 * a 401, not a redirect to sign-in and not a 200.
 */
async function checkGates(ctx: ProbeContext, signal: AbortSignal): Promise<string> {
  const origin = requireTrusted(ctx.origin);
  // The Origin is the origin called, as the chat call's is. Both routes decide an
  // anonymous caller at auth, before any origin check, so the 401 does not depend on it.
  const headers = { "content-type": "application/json", origin };
  // The chat body carries a real user message on purpose. /api/chat answers
  // 400 for a message-less body before it reaches the auth check, so an empty
  // body would pass for the wrong reason.
  const [chat, checkout] = await Promise.all([
    ctx.fetch(`${origin}/api/chat`, {
      method: "POST",
      redirect: "manual",
      signal,
      headers,
      body: JSON.stringify(chatRequestBody()),
    }),
    ctx.fetch(`${origin}/api/stripe/checkout`, {
      method: "POST",
      redirect: "manual",
      signal,
      headers,
      body: "{}",
    }),
  ]);
  await Promise.all([chat.text(), checkout.text()]);

  const problems: string[] = [];
  if (chat.status !== 401) problems.push(`/api/chat answered ${chat.status}, want 401`);
  if (checkout.status !== 401) {
    problems.push(`/api/stripe/checkout answered ${checkout.status}, want 401`);
  }
  if (problems.length > 0) throw new ProbeFailure(problems.join("; "));
  return "anonymous /api/chat and /api/stripe/checkout both 401";
}

/** The request body /api/chat reads. Exported for the tests that pin its shape. */
export function chatRequestBody(text: string = PAID_PROBE_QUESTION) {
  return {
    messages: [
      {
        id: "paid-probe-question",
        role: "user",
        parts: [{ type: "text", text }],
      },
    ],
  };
}

async function cleanUpConversation(
  ctx: ProbeContext,
  origin: string,
  cookie: ProbeCookie,
  conversationId: string | undefined,
): Promise<string> {
  if (!conversationId) return "no conversation id to clean up";
  try {
    const res = await ctx.fetch(`${origin}/chat.v1.ChatService/DeleteConversation`, {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(STEP_BUDGET_MS.chatCleanup),
      headers: {
        "content-type": "application/json",
        "connect-protocol-version": "1",
        origin,
        cookie: cookieHeader(cookie),
      },
      body: JSON.stringify({ conversationId }),
    });
    if (res.ok) {
      // The 2xx is the delete, so the step still passes. The body is read to free
      // the connection, but a read failure is reported: undici resolves fetch for a
      // body it cannot decode and throws only here, so this is where a bad
      // Content-Encoding would surface.
      const unread = await res.text().then(
        () => "",
        (err: unknown) => `; answer unreadable: ${failureCause(err)}`,
      );
      return `conversation deleted${unread}`;
    }
    return `cleanup warning: HTTP ${res.status}${await errorSuffix(res)}`;
  } catch (err) {
    // A warning, never a step failure: the answer itself was still judged.
    return `cleanup warning: ${failureCause(err)}`;
  }
}

/**
 * The error's name and the code of its cause, when it has one. undici reports a
 * body it cannot decode as a TypeError caused by a zlib code, so the code says
 * what failed. The messages are never used, because they can carry a URL. A
 * code that is not a plain token is dropped rather than echoed.
 */
function failureCause(err: unknown): string {
  const name = errorName(err);
  const cause = (err as { cause?: unknown } | null)?.cause;
  const code = (cause as { code?: unknown } | null | undefined)?.code;
  return typeof code === "string" && /^[A-Za-z0-9_]{1,40}$/.test(code) ? `${name} (${code})` : name;
}

function cookieHeader(cookie: ProbeCookie): string {
  return `${cookie.name}=${cookie.value}`;
}

/**
 * The message from a JSON error body (`{"error": "..."}` as the app's own
 * routes send), and nothing else. An HTML error page is never echoed.
 */
async function errorSuffix(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null) return "";
    const body = parsed as { error?: unknown; message?: unknown };
    const message =
      typeof body.error === "string"
        ? body.error
        : typeof body.message === "string"
          ? body.message
          : "";
    return message ? `: ${message}` : "";
  } catch {
    return "";
  }
}

function isJsonObject(text: string): boolean {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
  } catch {
    return false;
  }
}
