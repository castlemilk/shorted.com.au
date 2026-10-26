// use-chat pulls in ESM-only runtime packages (@ai-sdk/react, ai) and the
// generated Connect client. The helper under test is pure, so those modules are
// replaced here; the hook itself is exercised through the chat components.
jest.mock("@ai-sdk/react", () => ({ useChat: jest.fn() }));
jest.mock("ai", () => ({ DefaultChatTransport: class {} }));
jest.mock("@connectrpc/connect-web", () => ({ createConnectTransport: jest.fn() }));
jest.mock("@connectrpc/connect", () => ({ createClient: jest.fn() }));
jest.mock("~/gen/chat/v1/chat_pb", () => ({ ChatService: {} }));

import { conversationIdFromDataPart } from "../use-chat";

describe("conversationIdFromDataPart", () => {
  it("reads the id from a data-shorted-conversation part", () => {
    expect(
      conversationIdFromDataPart({
        type: "data-shorted-conversation",
        data: { conversationId: "conv-123" },
      }),
    ).toBe("conv-123");
  });

  it("ignores other part types, even ones that carry a conversation id", () => {
    expect(
      conversationIdFromDataPart({
        type: "data-shorted-final",
        data: { conversationId: "conv-123" },
      }),
    ).toBeUndefined();
    expect(conversationIdFromDataPart({ type: "text", text: "hi" })).toBeUndefined();
  });

  it.each([
    [undefined],
    [null],
    ["data-shorted-conversation"],
    [{ type: "data-shorted-conversation" }],
    [{ type: "data-shorted-conversation", data: null }],
    [{ type: "data-shorted-conversation", data: { conversationId: 42 } }],
    [{ type: "data-shorted-conversation", data: { conversationId: "   " } }],
  ])("returns undefined for a malformed value %p", (value) => {
    expect(conversationIdFromDataPart(value)).toBeUndefined();
  });
});
