/**
 * Chat rate-limit `product_event` labels.
 *
 * Chat is the one web surface with a bucket that is neither per-minute nor
 * monthly, and the one whose method label arrives from a proxy route as a raw
 * string — the two places this could quietly go wrong.
 */
import {
  chatActionForMethod,
  chatRateLimitConfigs,
  limitKindForBucket,
} from "../chat-server-guards";
import { buildProductEvent } from "../product-events";

describe("limitKindForBucket", () => {
  it("names each chat window", () => {
    expect(limitKindForBucket(60)).toBe("per_minute");
    expect(limitKindForBucket(86_400)).toBe("daily");
    expect(limitKindForBucket(2_592_000)).toBe("monthly");
  });

  it("covers every window the send path actually configures", () => {
    const kinds = chatRateLimitConfigs("SendMessage", {} as NodeJS.ProcessEnv).map(
      (c) => limitKindForBucket(c.windowSeconds),
    );
    expect(kinds).toEqual(["per_minute", "daily", "monthly"]);
  });

  it("survives the product_event allow-list — a dropped kind would read as unknown", () => {
    for (const seconds of [60, 86_400, 2_592_000]) {
      const kind = limitKindForBucket(seconds);
      const event = buildProductEvent({
        feature: "chat",
        action: "sendmessage",
        status: "rate_limited",
        properties: { limit_kind: kind },
      });
      expect(event.limit_kind).toBe(kind);
    }
  });
});

describe("chatActionForMethod", () => {
  it("maps the allowed methods to stable lower-case labels", () => {
    expect(chatActionForMethod("SendMessage")).toBe("sendmessage");
    expect(chatActionForMethod("ListConversations")).toBe("listconversations");
  });

  it("collapses anything else to a single label — action is a metric dimension", () => {
    expect(chatActionForMethod("DropTables")).toBe("other");
    expect(chatActionForMethod("../../etc/passwd")).toBe("other");
    expect(chatActionForMethod("")).toBe("other");
  });
});
