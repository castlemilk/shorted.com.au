import { readFileSync } from "node:fs";
import path from "node:path";

import { parseChatUIStream, toolCallFailure } from "../sse";

// The fixtures were recorded from the ai package's own writer (see the
// __fixtures__ directory), so these tests pin the real framing, not a guess at it.
function fixture(name: string): string {
  return readFileSync(path.join(__dirname, "..", "__fixtures__", name), "utf8");
}

describe("parseChatUIStream", () => {
  it("reads a healthy recorded stream into text, the final part and [DONE]", () => {
    const parsed = parseChatUIStream(fixture("chat-stream-ok.sse"));

    expect(parsed.done).toBe(true);
    expect(parsed.errors).toEqual([]);
    expect(parsed.text).toBe("BHP's reported short position is 1.2%.");
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
