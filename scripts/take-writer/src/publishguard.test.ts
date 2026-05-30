import { describe, it, expect } from "vitest";
import { shouldHoldAsDraft } from "./newsroom.js";

describe("shouldHoldAsDraft", () => {
  it("holds when there are dropped (dangling) citations", () => {
    expect(shouldHoldAsDraft({ droppedCitations: ["ref-9"], citations: [{ refId: "ref-1" } as any] })).toBe(true);
  });
  it("holds a deep_dive with zero citations (ungrounded long-form)", () => {
    expect(shouldHoldAsDraft({ droppedCitations: [], citations: [], tier: "deep_dive" } as any)).toBe(true);
  });
  it("allows a clean grounded take through", () => {
    expect(shouldHoldAsDraft({ droppedCitations: [], citations: [{ refId: "ref-1" } as any], tier: "take" } as any)).toBe(false);
  });
});
