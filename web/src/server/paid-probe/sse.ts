/**
 * Reader for the UI-message stream /api/chat answers with (ai@7's
 * createUIMessageStreamResponse): one `data: <json>` event per part, separated
 * by a blank line, and a terminal `data: [DONE]`. Recorded fixtures live in
 * __fixtures__ and were produced by the ai package itself, not by hand.
 */

export interface ProbeToolCall {
  toolName: string;
  arguments: string;
  result: string;
}

export interface ProbeFinalData {
  conversationId?: string;
  toolCalls?: ProbeToolCall[];
}

export interface ParsedChatStream {
  /** True once the terminal `[DONE]` event arrived. */
  done: boolean;
  /** Every text-delta concatenated, in order. */
  text: string;
  /** errorText of every `error` chunk. The route's onError sends a fixed string. */
  errors: string[];
  /** Data of the last `data-shorted-final` part, or null when none arrived. */
  finalData: ProbeFinalData | null;
}

export function parseChatUIStream(body: string): ParsedChatStream {
  const parsed: ParsedChatStream = { done: false, text: "", errors: [], finalData: null };

  // The framing is LF-terminated today, but a CRLF from a proxy must not turn
  // every event into one unparseable blob.
  for (const block of body.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).replace(/^ /, ""))
      .join("\n");
    if (!data) continue;
    if (data === "[DONE]") {
      parsed.done = true;
      continue;
    }

    let part: unknown;
    try {
      part = JSON.parse(data);
    } catch {
      // Ignored rather than fatal: a malformed event fails the assertions
      // through its absence (no text, no final part) without echoing its bytes.
      continue;
    }
    if (!isRecord(part) || typeof part.type !== "string") continue;

    switch (part.type) {
      case "text-delta":
        if (typeof part.delta === "string") parsed.text += part.delta;
        break;
      case "error":
        parsed.errors.push(typeof part.errorText === "string" ? part.errorText : "unknown error");
        break;
      case "data-shorted-final":
        parsed.finalData = isRecord(part.data) ? (part.data as ProbeFinalData) : null;
        break;
      default:
        break;
    }
  }
  return parsed;
}

/**
 * Whether one tool call failed, and why (null when it did not).
 *
 * services/chat-service/llm_client.go replaces a failed tool execution's result
 * with `Error: <execErr>` (in both the streaming and the non-streaming loop) and
 * records that string in the returned toolCalls. A successful execution returns
 * the upstream Connect JSON body, which never starts with `Error:`. So the
 * prefix is the whole predicate. It covers the upstream shape the 2026-10-23
 * outage produced (`Error: RPC GetStockDetails returned 403: ...`) and also the
 * chat-service's own validation and unknown-tool errors, because the probe asks
 * one fixed question and any tool error on it is a regression.
 */
export function toolCallFailure(call: ProbeToolCall): string | null {
  const result = call.result.trimStart();
  if (!result.startsWith("Error:")) return null;
  return `${call.toolName}: ${result.slice("Error:".length).trim()}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
