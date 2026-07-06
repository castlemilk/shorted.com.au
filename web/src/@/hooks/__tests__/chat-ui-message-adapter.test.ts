import {
  chatMessageToUIMessage,
  extractLatestUserText,
  uiMessageToChatMessage,
} from "../chat-ui-message-adapter";
import type { ChatMessage } from "../use-chat";

const toolCalls = [
  {
    toolName: "get_stock_details",
    arguments: JSON.stringify({ stock_code: "ZIP" }),
    result: JSON.stringify({ stock: { productCode: "ZIP" } }),
  },
];

const citations = [
  {
    sourceType: "asx_announcement",
    reference: "ZIP 2026-07-06",
    url: "https://example.com/zip.pdf",
  },
];

describe("chat UI message adapter", () => {
  it("extracts the latest user text from AI SDK UI messages", () => {
    expect(
      extractLatestUserText([
        {
          id: "assistant-1",
          role: "assistant",
          parts: [{ type: "text", text: "Older answer" }],
        },
        {
          id: "user-1",
          role: "user",
          parts: [
            { type: "text", text: "Show me " },
            { type: "text", text: "ZIP short interest" },
          ],
        },
      ]),
    ).toBe("Show me ZIP short interest");
  });

  it("keeps Shorted tool calls and citations in a data part", () => {
    const message: ChatMessage = {
      id: "assistant-2",
      role: "assistant",
      content: "Here is **ZIP**.\n\n| Metric | Value |\n| --- | --- |\n| Short | 6.42% |",
      toolCalls,
      citations,
      createdAt: new Date("2026-07-06T00:00:00.000Z"),
    };

    const uiMessage = chatMessageToUIMessage(message);
    const roundTripped = uiMessageToChatMessage(uiMessage);

    expect(uiMessage.parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "data-shorted-final",
          data: expect.objectContaining({
            toolCalls,
            citations,
          }),
        }),
      ]),
    );
    expect(roundTripped.content).toContain("| Metric | Value |");
    expect(roundTripped.toolCalls).toEqual(toolCalls);
    expect(roundTripped.citations).toEqual(citations);
  });

  it("marks an assistant text part as streaming while AI SDK is still receiving it", () => {
    const message = uiMessageToChatMessage({
      id: "assistant-streaming",
      role: "assistant",
      parts: [{ type: "text", text: "Thinking", state: "streaming" }],
    });

    expect(message.isStreaming).toBe(true);
  });
});
