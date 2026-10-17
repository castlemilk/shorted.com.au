import { describe, expect, it } from "vitest";
import { illustrationCaption, ILLUSTRATION_CREDIT } from "./illustration-caption.js";

describe("generated illustration captions", () => {
  it("uses an illustrative caption for new OG fallback art without inheriting a photo location", () => {
    const oldPhotoCaption = "Core samples at Kayelekera mine, Malawi";
    expect(illustrationCaption(oldPhotoCaption)).toBe("Illustration: the article's central mechanism");
    expect(illustrationCaption()).toBe("Illustration: the article's central mechanism");
    expect(ILLUSTRATION_CREDIT).toBe("AI-generated illustration");
  });

  it("retains a valid conceptual caption while normalising its prefix", () => {
    expect(illustrationCaption("  illustration:  scissors trimming a blank sale tag  ")).toBe("Illustration: scissors trimming a blank sale tag");
  });

  it("supplies safe metadata when the model returns an empty caption", () => {
    for (const caption of [null, "", "   ", "Illustration:   "]) {
      expect(illustrationCaption(caption)).toBe("Illustration: the article's central mechanism");
    }
  });
});
