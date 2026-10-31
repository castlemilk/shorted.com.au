import { DISCORD_API_BASE, type MessagePayload } from "./api";

/**
 * The webhook calls that finish a deferred interaction. They authenticate with
 * the interaction's own token (valid for 15 minutes), so the endpoint needs no
 * bot token at all; only the command registration script does.
 */

const USER_AGENT = "DiscordBot (https://shorted.com.au, 1.0)";
const TIMEOUT_MS = 5000;
/** An upload carries a chart card (~150KB), so it gets longer than a JSON edit. */
const UPLOAD_TIMEOUT_MS = 10_000;

/**
 * The request body: JSON, or with files Discord's multipart form, whose
 * `payload_json` lists them as the message's attachments (an edit keeps only
 * the attachments it lists) and whose `files[n]` parts carry the bytes.
 */
export function messageBody(payload: MessagePayload): {
  body: string | FormData;
  headers: Record<string, string>;
} {
  const { files, ...message } = payload;
  if (!files?.length) {
    return {
      body: JSON.stringify(message),
      headers: { "Content-Type": "application/json" },
    };
  }
  const form = new FormData();
  form.append(
    "payload_json",
    JSON.stringify({
      ...message,
      attachments: files.map((file, id) => ({
        id,
        filename: file.name,
        ...(file.description ? { description: file.description } : {}),
      })),
    }),
  );
  files.forEach((file, id) => {
    form.append(
      `files[${id}]`,
      new Blob([file.data], { type: file.contentType }),
      file.name,
    );
  });
  // fetch sets the multipart Content-Type, boundary included.
  return { body: form, headers: {} };
}

/** Waits before the second and third attempts (a 429's own Retry-After wins). */
export const RETRY_DELAYS_MS = [400, 1200];
const MAX_RETRY_AFTER_MS = 5000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Discord's Retry-After (seconds, possibly fractional), capped; null without one. */
function retryAfterMs(response: Response): number | null {
  const seconds = Number(response.headers.get("retry-after"));
  return Number.isFinite(seconds) && seconds > 0
    ? Math.min(seconds * 1000, MAX_RETRY_AFTER_MS)
    : null;
}

/**
 * One webhook call, tried up to three times: a 429 (after its Retry-After), a
 * 5xx, or for an edit or a delete a failed connection. A follow-up (POST) is
 * not resent after a failed connection, which may have delivered it, since a
 * second copy would post twice. Any other answer is final.
 */
async function call(
  method: "PATCH" | "POST" | "DELETE",
  path: string,
  payload?: MessagePayload,
): Promise<void> {
  const name = `Discord ${method} ${path.replace(/\/[^/]{60,}/, "/<token>")}`;
  for (let attempt = 0; ; attempt += 1) {
    const last = attempt >= RETRY_DELAYS_MS.length;
    // A body is read once, so each attempt encodes its own.
    const encoded = payload === undefined ? undefined : messageBody(payload);
    let response: Response;
    try {
      response = await fetch(`${DISCORD_API_BASE}${path}`, {
        method,
        headers: { ...encoded?.headers, "User-Agent": USER_AGENT },
        body: encoded?.body,
        cache: "no-store",
        signal: AbortSignal.timeout(
          payload?.files?.length ? UPLOAD_TIMEOUT_MS : TIMEOUT_MS,
        ),
      });
    } catch (error) {
      if (last || method === "POST") throw error;
      await sleep(RETRY_DELAYS_MS[attempt]!);
      continue;
    }
    if (response.ok) return;
    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || last) {
      const text = await response.text().catch(() => "");
      throw new Error(`${name} -> ${response.status}: ${text.slice(0, 200)}`);
    }
    await sleep(retryAfterMs(response) ?? RETRY_DELAYS_MS[attempt]!);
  }
}

function webhook(applicationId: string, token: string): string {
  return `/webhooks/${encodeURIComponent(applicationId)}/${encodeURIComponent(token)}`;
}

/** Replace the deferred "thinking…" response (or the message a button sits on). */
export function editOriginal(
  applicationId: string,
  token: string,
  payload: MessagePayload,
): Promise<void> {
  return call(
    "PATCH",
    `${webhook(applicationId, token)}/messages/@original`,
    payload,
  );
}

export function deleteOriginal(
  applicationId: string,
  token: string,
): Promise<void> {
  return call("DELETE", `${webhook(applicationId, token)}/messages/@original`);
}

/** A new message in reply to the interaction (ephemeral when its flags say so). */
export function followUp(
  applicationId: string,
  token: string,
  payload: MessagePayload,
): Promise<void> {
  return call("POST", webhook(applicationId, token), payload);
}

export interface DiscordRest {
  editOriginal: typeof editOriginal;
  deleteOriginal: typeof deleteOriginal;
  followUp: typeof followUp;
}

export const discordRest: DiscordRest = {
  editOriginal,
  deleteOriginal,
  followUp,
};
