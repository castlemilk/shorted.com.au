/**
 * Reader for the UI-message stream /api/chat answers with (ai@7's
 * createUIMessageStreamResponse): one `data: <json>` event per part, separated
 * by a blank line, and a terminal `data: [DONE]`. Recorded fixtures live in
 * __fixtures__ and were produced by the ai package itself, not by hand.
 *
 * The parser is incremental on purpose. A turn that times out must still
 * yield the conversation id it streamed before the cut, so the caller can
 * delete that conversation. Reading the whole body at the end would lose it.
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
  /**
   * Conversation id from the data-shorted-conversation part, which the route
   * emits as soon as the conversation exists, before any answer text.
   */
  conversationPartId: string | undefined;
  /** Data of the last data-shorted-final part, or null when none arrived. */
  finalData: ProbeFinalData | null;
}

const EVENT_BOUNDARY = /\r?\n\r?\n/;

export class ChatStreamParser {
  private buffer = "";
  private readonly parsed: ParsedChatStream = {
    done: false,
    text: "",
    errors: [],
    conversationPartId: undefined,
    finalData: null,
  };

  /** Feed the next decoded chunk. Complete events are applied at once; a partial one waits. */
  push(chunk: string): void {
    this.buffer += chunk;
    let boundary = EVENT_BOUNDARY.exec(this.buffer);
    while (boundary) {
      const block = this.buffer.slice(0, boundary.index);
      this.buffer = this.buffer.slice(boundary.index + boundary[0].length);
      this.apply(block);
      boundary = EVENT_BOUNDARY.exec(this.buffer);
    }
  }

  /** The stream ended: apply whatever is left as a final event. */
  finish(): void {
    if (this.buffer.trim() !== "") this.apply(this.buffer);
    this.buffer = "";
  }

  /** What has been seen so far. Safe to read after a failed or cut-off read. */
  snapshot(): ParsedChatStream {
    return this.parsed;
  }

  /**
   * The conversation this turn belongs to, as soon as either part has named it.
   * The conversation part wins, so a turn cut off before its final part is still
   * cleaned up. The final part is the fallback for a stream that never sent one.
   */
  knownConversationId(): string | undefined {
    return this.parsed.conversationPartId ?? nonEmptyString(this.parsed.finalData?.conversationId);
  }

  private apply(block: string): void {
    const payload = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).replace(/^ /, ""))
      .join("\n");
    if (!payload) return;
    if (payload === "[DONE]") {
      this.parsed.done = true;
      return;
    }

    let part: unknown;
    try {
      part = JSON.parse(payload);
    } catch {
      // Ignored rather than fatal: a malformed event fails the assertions
      // through its absence (no text, no final part) without echoing its bytes.
      return;
    }
    if (!isRecord(part) || typeof part.type !== "string") return;

    switch (part.type) {
      case "text-delta":
        if (typeof part.delta === "string") this.parsed.text += part.delta;
        break;
      case "error":
        this.parsed.errors.push(typeof part.errorText === "string" ? part.errorText : "unknown error");
        break;
      case "data-shorted-conversation": {
        const data = isRecord(part.data) ? part.data : undefined;
        const id = nonEmptyString(data?.conversationId);
        if (id && this.parsed.conversationPartId === undefined) this.parsed.conversationPartId = id;
        break;
      }
      case "data-shorted-final":
        this.parsed.finalData = isRecord(part.data) ? (part.data as ProbeFinalData) : null;
        break;
      default:
        break;
    }
  }
}

/** Read a whole chat response body into the parser. A failed read throws, with the parser keeping what it saw. */
export async function consumeChatStream(
  body: ReadableStream<Uint8Array> | null,
  parser: ChatStreamParser,
): Promise<void> {
  if (body === null) {
    parser.finish();
    return;
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parser.push(decoder.decode(value, { stream: true }));
  }
  parser.push(decoder.decode());
  parser.finish();
}

/** Parse a complete recorded stream in one go. */
export function parseChatUIStream(body: string): ParsedChatStream {
  const parser = new ChatStreamParser();
  parser.push(body);
  parser.finish();
  return parser.snapshot();
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

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
