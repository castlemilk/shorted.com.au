/**
 * Shorted AI chat errors.
 *
 * The chat API answers every non-2xx response, and every in-stream error chunk,
 * with one JSON contract:
 *
 *   { error, code, message, retryAfterSeconds?, limitKind?, resetAt? }
 *
 * `useChat`'s transport throws an Error whose message is that body text, and an
 * in-stream error surfaces the same JSON as `errorText`. Older builds and the
 * edge sent other shapes (`{ error: "Rate limit exceeded" }`, a plain string,
 * an HTML error page), so this parser tolerates all of them and always returns
 * a code the UI can render. Nothing here imports Connect-RPC: this module is
 * reached from SSR-adjacent code paths and must stay pure.
 */

export type ChatErrorCode =
  | "unauthenticated"
  | "premium_required"
  | "rate_limited"
  | "invalid_request"
  | "unavailable";

export type ChatLimitKind = "per_minute" | "daily" | "monthly" | "global";

export interface ChatErrorInfo {
  code: ChatErrorCode;
  /** Human text from the API, already vetted: "" when none was usable. */
  message: string;
  /** Seconds until the caller may retry, as the API reported it. */
  retryAfterSeconds?: number;
  /** Which window was exhausted, for rate_limited. */
  limitKind?: ChatLimitKind;
  /** Unix seconds when the exhausted window resets. */
  resetAt?: number;
}

export const CHAT_ERROR_CODES: readonly ChatErrorCode[] = [
  "unauthenticated",
  "premium_required",
  "rate_limited",
  "invalid_request",
  "unavailable",
];

const LIMIT_KINDS: readonly ChatLimitKind[] = [
  "per_minute",
  "daily",
  "monthly",
  "global",
];

/** A server message longer than this is truncated rather than shown whole. */
const MAX_MESSAGE_LENGTH = 300;

export const GENERIC_UNAVAILABLE_MESSAGE =
  "Something went wrong on our side. Please try again in a moment.";

/**
 * Turns anything `useChat` or the transport can throw into a ChatErrorInfo.
 * Never throws, and never returns text that looks like JSON or markup.
 */
export function parseChatError(err: unknown): ChatErrorInfo {
  const text = errorText(err);
  if (text === undefined) return unavailable();

  const body = parseJSONObject(text);
  if (body) return fromBody(body);

  return fromPlainText(text);
}

/** Whole seconds until the exhausted window resets, or undefined if unknown. */
export function secondsUntilReset(
  info: ChatErrorInfo,
  nowMs: number = Date.now(),
): number | undefined {
  if (typeof info.resetAt === "number") {
    return Math.max(0, Math.ceil(info.resetAt - nowMs / 1000));
  }
  if (typeof info.retryAfterSeconds === "number") {
    return Math.max(0, Math.ceil(info.retryAfterSeconds));
  }
  return undefined;
}

/** "45 seconds", "1 minute", "3 hours", "2 days". */
export function formatWait(seconds: number): string {
  if (seconds < 60) return plural(Math.max(1, seconds), "second");
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return plural(minutes, "minute");
  const hours = Math.ceil(minutes / 60);
  if (hours < 24) return plural(hours, "hour");
  return plural(Math.ceil(hours / 24), "day");
}

export interface ChatErrorCopy {
  title: string;
  detail?: string;
}

/**
 * The words a user sees for an error. Built from the code and its fields only,
 * so the page never renders the raw contract, and rate limits name the window
 * that was hit.
 */
export function chatErrorCopy(
  info: ChatErrorInfo,
  nowMs: number = Date.now(),
): ChatErrorCopy {
  switch (info.code) {
    case "rate_limited": {
      const wait = secondsUntilReset(info, nowMs);
      const waitText =
        wait === undefined ? undefined : `Try again in ${formatWait(wait)}.`;
      switch (info.limitKind) {
        case "global":
          return {
            title: "Chat is busy right now",
            detail: waitText ?? "Please try again shortly.",
          };
        case "per_minute":
          return {
            title: "You've reached your chat limit for this minute",
            detail: waitText,
          };
        case "daily":
          return {
            title: "You've reached your chat limit for today",
            detail: waitText,
          };
        case "monthly":
          return {
            title: "You've reached your chat limit for this month",
            detail: waitText,
          };
        default:
          return { title: "You've reached your chat limit", detail: waitText };
      }
    }
    case "premium_required":
      return {
        title: "AI chat is a premium feature",
        detail:
          "Upgrade to ask Shorted AI about any stock, short position or market trend.",
      };
    case "unauthenticated":
      return {
        title: "Sign in to use Shorted AI",
        detail: "Your session has ended, or you are not signed in.",
      };
    case "invalid_request":
      return {
        title: "That message could not be sent",
        detail: info.message || "Check the message and try again.",
      };
    case "unavailable":
      return {
        title: "Shorted AI is temporarily unavailable",
        detail: GENERIC_UNAVAILABLE_MESSAGE,
      };
  }
}

function unavailable(): ChatErrorInfo {
  return { code: "unavailable", message: "" };
}

function fromBody(body: Record<string, unknown>): ChatErrorInfo {
  const contractCode = isChatErrorCode(body.code) ? body.code : undefined;
  // In the contract `message` is the sentence and `error` a short name, so
  // `error` is read as a sentence only when the body has no contract code.
  const sentence =
    stringField(body.message) ??
    (contractCode ? undefined : stringField(body.error));
  const code = contractCode ?? classifyLegacy(sentence ?? "");

  return withOptionalFields({ code, message: humanMessage(sentence) }, body);
}

function fromPlainText(text: string): ChatErrorInfo {
  // An HTML error page (a proxy or CDN) is never a message we can show.
  if (/<\s*(!doctype|html|body)\b/i.test(text)) return unavailable();

  const code = classifyLegacy(text);
  return { code, message: code === "invalid_request" ? humanMessage(text) : "" };
}

/**
 * Maps a free-text error from a contract-less response to a code. Anything not
 * recognised is treated as the service being unavailable, which is the only
 * recovery the user can take anyway (retry).
 */
function classifyLegacy(text: string): ChatErrorCode {
  if (/rate limit|too many requests|quota/i.test(text)) return "rate_limited";
  if (/unauthori[sz]ed|not signed in|sign in|log ?in required/i.test(text)) {
    return "unauthenticated";
  }
  if (/premium|subscription|upgrade/i.test(text)) return "premium_required";
  if (/invalid|required|too long|bad request/i.test(text)) {
    return "invalid_request";
  }
  return "unavailable";
}

function withOptionalFields(
  info: ChatErrorInfo,
  body: Record<string, unknown>,
): ChatErrorInfo {
  const next: ChatErrorInfo = { ...info };
  const retryAfter = finiteNumber(body.retryAfterSeconds);
  if (retryAfter !== undefined && retryAfter >= 0) {
    next.retryAfterSeconds = retryAfter;
  }
  const resetAt = finiteNumber(body.resetAt);
  if (resetAt !== undefined && resetAt > 0) {
    next.resetAt = resetAt;
  }
  if (isLimitKind(body.limitKind)) {
    next.limitKind = body.limitKind;
  }
  return next;
}

/**
 * Human text the server may have written. Anything that starts like JSON or
 * markup is dropped, because it is a payload and not a sentence.
 */
function humanMessage(value: string | undefined): string {
  if (!value) return "";
  const trimmed = value.trim();
  if (!trimmed || /^[{[<]/.test(trimmed)) return "";
  return trimmed.length > MAX_MESSAGE_LENGTH
    ? `${trimmed.slice(0, MAX_MESSAGE_LENGTH - 1)}…`
    : trimmed;
}

function errorText(err: unknown): string | undefined {
  if (typeof err === "string") return nonEmpty(err);
  if (err instanceof Error) return nonEmpty(err.message);
  if (err && typeof err === "object") {
    const record = err as Record<string, unknown>;
    return nonEmpty(stringField(record.errorText) ?? stringField(record.message));
  }
  return undefined;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function parseJSONObject(text: string): Record<string, unknown> | undefined {
  if (!text.startsWith("{")) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isChatErrorCode(value: unknown): value is ChatErrorCode {
  return (
    typeof value === "string" &&
    (CHAT_ERROR_CODES as readonly string[]).includes(value)
  );
}

function isLimitKind(value: unknown): value is ChatLimitKind {
  return (
    typeof value === "string" &&
    (LIMIT_KINDS as readonly string[]).includes(value)
  );
}

function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? "" : "s"}`;
}
