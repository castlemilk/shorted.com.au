/** @jest-environment node */
import { ChatStreamParser, consumeChatStream, parseChatUIStream, toolCallFailure } from "../sse";
import { cutOffStream, fixture, streamOf } from "./helpers";

describe("parseChatUIStream", () => {
  it("reads a healthy recorded stream into text, the final part and [DONE]", () => {
    const parsed = parseChatUIStream(fixture("chat-stream-ok.sse"));

    expect(parsed.done).toBe(true);
    expect(parsed.errors).toEqual([]);
    expect(parsed.text).toBe("BHP's reported short position is 1.2%.");
    expect(parsed.conversationPartId).toBeUndefined();
    expect(parsed.finalData?.conversationId).toBe("conv-probe-ok");
    expect(parsed.finalData?.toolCalls).toEqual([
      {
        toolName: "query_short_positions",
        arguments: '{"stock_code":"BHP"}',
        result: '{"productCode":"BHP","percentage":1.2}',
      },
    ]);
  });

  it("reads the 2026-10-23 stream: the answer arrives, and the tool failure rides in the final part", () => {
    const parsed = parseChatUIStream(fixture("chat-stream-tool-403.sse"));

    expect(parsed.done).toBe(true);
    expect(parsed.errors).toEqual([]);
    expect(parsed.finalData?.toolCalls?.[0]?.result).toBe(
      'Error: RPC GetStockDetails returned 403: {"code":"permission_denied","message":"automated access detected, ..."}',
    );
  });

  it("reads the error chunk the route's onError produces, and still sees [DONE]", () => {
    const parsed = parseChatUIStream(fixture("chat-stream-error.sse"));

    expect(parsed.errors).toEqual(["Chat is temporarily unavailable."]);
    expect(parsed.done).toBe(true);
    expect(parsed.finalData).toBeNull();
  });

  it("reads the conversation part the route emits before any answer text", () => {
    const parsed = parseChatUIStream(fixture("chat-stream-conversation-part.sse"));

    expect(parsed.done).toBe(true);
    expect(parsed.conversationPartId).toBe("conv-probe-part");
    expect(parsed.text).toBe("BHP's reported short position is 1.2%.");
  });

  it("keeps the conversation id of a turn cut off before its final part, which is what cleanup needs", () => {
    const parsed = parseChatUIStream(fixture("chat-stream-conversation-timeout.sse"));

    expect(parsed.done).toBe(false);
    expect(parsed.finalData).toBeNull();
    expect(parsed.conversationPartId).toBe("conv-probe-part");
    expect(parsed.text).toBe("BHP's reported short position ");
  });

  it("reports a stream that never reaches [DONE]", () => {
    const parsed = parseChatUIStream(
      'data: {"type":"text-start","id":"a"}\n\ndata: {"type":"text-delta","id":"a","delta":"hi"}\n\n',
    );
    expect(parsed.done).toBe(false);
    expect(parsed.text).toBe("hi");
  });

  it("tolerates CRLF framing", () => {
    const crlf = fixture("chat-stream-ok.sse").replace(/\n/g, "\r\n");
    const parsed = parseChatUIStream(crlf);
    expect(parsed.done).toBe(true);
    expect(parsed.text).toBe("BHP's reported short position is 1.2%.");
  });

  it("skips malformed events without echoing their bytes", () => {
    const body = 'data: {not json SECRET-BYTES\n\ndata: {"type":"text-delta","id":"a","delta":"ok"}\n\ndata: [DONE]\n\n';
    const parsed = parseChatUIStream(body);
    expect(parsed.text).toBe("ok");
    expect(parsed.done).toBe(true);
    expect(JSON.stringify(parsed)).not.toContain("SECRET-BYTES");
  });
});

describe("ChatStreamParser", () => {
  it("parses the same whether the bytes arrive whole or in small pieces", () => {
    const whole = parseChatUIStream(fixture("chat-stream-conversation-part.sse"));

    const body = fixture("chat-stream-conversation-part.sse");
    const parser = new ChatStreamParser();
    for (let i = 0; i < body.length; i += 5) parser.push(body.slice(i, i + 5));
    parser.finish();

    expect(parser.snapshot()).toEqual(whole);
  });

  it("holds a CRLF event boundary that is split across chunks", () => {
    const parser = new ChatStreamParser();
    parser.push('data: {"type":"data-shorted-conversation","id":"c","data":{"conversationId":"conv-split"}}\r\n\r');
    // The event is not complete until its blank line is, so it waits.
    expect(parser.knownConversationId()).toBeUndefined();
    parser.push("\ndata: [DONE]\r\n\r\n");
    expect(parser.knownConversationId()).toBe("conv-split");
    expect(parser.snapshot().done).toBe(true);
  });

  it("applies a trailing event that never got its blank line when the stream ends", () => {
    const parser = new ChatStreamParser();
    parser.push('data: {"type":"data-shorted-conversation","id":"c","data":{"conversationId":"conv-tail"}}');
    expect(parser.knownConversationId()).toBeUndefined();
    parser.finish();
    expect(parser.knownConversationId()).toBe("conv-tail");
  });

  it("prefers the conversation part's id over the final part's", () => {
    const parser = new ChatStreamParser();
    parser.push('data: {"type":"data-shorted-conversation","id":"c","data":{"conversationId":"conv-a"}}\n\n');
    parser.push('data: {"type":"data-shorted-final","id":"f","data":{"conversationId":"conv-b"}}\n\n');
    expect(parser.knownConversationId()).toBe("conv-a");
  });

  it("falls back to the final part's id when no conversation part was streamed", () => {
    const parser = new ChatStreamParser();
    parser.push('data: {"type":"data-shorted-final","id":"f","data":{"conversationId":"conv-b"}}\n\n');
    expect(parser.knownConversationId()).toBe("conv-b");
  });

  it("ignores an empty conversation id", () => {
    const parser = new ChatStreamParser();
    parser.push('data: {"type":"data-shorted-conversation","id":"c","data":{"conversationId":""}}\n\n');
    expect(parser.knownConversationId()).toBeUndefined();
  });
});

describe("consumeChatStream", () => {
  it("reads a body delivered in pieces into the parser", async () => {
    const body = fixture("chat-stream-ok.sse");
    const parser = new ChatStreamParser();
    await consumeChatStream(streamOf(body.slice(0, 40), body.slice(40)), parser);
    expect(parser.snapshot().done).toBe(true);
    expect(parser.snapshot().text).toBe("BHP's reported short position is 1.2%.");
  });

  it("keeps the conversation id when the read is cut off, and then rejects", async () => {
    const parser = new ChatStreamParser();
    await expect(
      consumeChatStream(cutOffStream(fixture("chat-stream-conversation-timeout.sse")), parser),
    ).rejects.toMatchObject({ name: "TimeoutError" });

    expect(parser.knownConversationId()).toBe("conv-probe-part");
    expect(parser.snapshot().done).toBe(false);
  });

  it("treats a missing body as an empty answer", async () => {
    const parser = new ChatStreamParser();
    await consumeChatStream(null, parser);
    expect(parser.snapshot()).toMatchObject({ done: false, text: "", finalData: null });
  });
});

describe("toolCallFailure", () => {
  it("fails the 2026-10-23 result", () => {
    const failure = toolCallFailure({
      toolName: "get_stock_details",
      arguments: '{"stock_code":"BHP"}',
      result:
        'Error: RPC GetStockDetails returned 403: {"code":"permission_denied","message":"automated access detected, ..."}',
    });
    expect(failure).toBe(
      'get_stock_details: RPC GetStockDetails returned 403: {"code":"permission_denied","message":"automated access detected, ..."}',
    );
  });

  it("fails the chat-service's own validation and unknown-tool errors too", () => {
    expect(
      toolCallFailure({ toolName: "get_economic_series", arguments: "{}", result: "Error: series_keys must be a non-empty string array" }),
    ).not.toBeNull();
    expect(toolCallFailure({ toolName: "mystery", arguments: "{}", result: "Error: unknown tool: mystery" })).not.toBeNull();
  });

  it("passes a successful Connect JSON result", () => {
    expect(
      toolCallFailure({ toolName: "query_short_positions", arguments: "{}", result: '{"productCode":"BHP"}' }),
    ).toBeNull();
  });

  it("does not fail a result that merely mentions an error mid-body", () => {
    expect(
      toolCallFailure({ toolName: "get_news", arguments: "{}", result: '{"headline":"Error: none reported"}' }),
    ).toBeNull();
  });
});
