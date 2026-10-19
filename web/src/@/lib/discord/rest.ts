import { DISCORD_API_BASE, type MessagePayload } from "./api";

/**
 * The webhook calls that finish a deferred interaction. They authenticate with
 * the interaction's own token (valid for 15 minutes), so the endpoint needs no
 * bot token at all; only the command registration script does.
 */

const USER_AGENT = "DiscordBot (https://shorted.com.au, 1.0)";
const TIMEOUT_MS = 5000;

async function call(
  method: "PATCH" | "POST" | "DELETE",
  path: string,
  body?: MessagePayload,
): Promise<void> {
  const response = await fetch(`${DISCORD_API_BASE}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "User-Agent": USER_AGENT,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Discord ${method} ${path.replace(/\/[^/]{60,}/, "/<token>")} -> ${response.status}: ${text.slice(0, 200)}`,
    );
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
