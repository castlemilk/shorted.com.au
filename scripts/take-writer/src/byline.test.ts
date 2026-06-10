import { describe, it, expect } from "vitest";
import { deskByline } from "./byline.js";

describe("deskByline", () => {
  it("maps mining industries to the Mining & Resources beat", () => {
    expect(deskByline("Gold Mining")).toBe("The Shorted Desk — Mining & Resources");
  });

  it("falls back to Markets when industry is null", () => {
    expect(deskByline(null)).toBe("The Shorted Desk — Markets");
  });

  it("maps software to the Technology & Media beat", () => {
    expect(deskByline("Software & Services")).toBe("The Shorted Desk — Technology & Media");
  });
});
