import { describe, it, expect } from "vitest";
import { needsImages } from "./publish.js";

const OG = "https://storage.googleapis.com/x/takes/slug-og.png";
const HERO = "https://storage.googleapis.com/x/takes/slug-hero.png";

describe("needsImages", () => {
  it("true when hero_image_url is null", () => {
    expect(needsImages({ hero_image_url: null, og_image_url: OG, layout_images: [{}] })).toBe(true);
  });

  it("true when layout_images is empty (or null)", () => {
    expect(needsImages({ hero_image_url: HERO, og_image_url: OG, layout_images: [] })).toBe(true);
    expect(needsImages({ hero_image_url: HERO, og_image_url: OG, layout_images: null })).toBe(true);
  });

  it("true when the hero is just the brand OG fallback (hero === og)", () => {
    expect(needsImages({ hero_image_url: OG, og_image_url: OG, layout_images: [{}, {}] })).toBe(true);
  });

  it("false when a distinct hero and a non-empty layout plan exist", () => {
    expect(needsImages({ hero_image_url: HERO, og_image_url: OG, layout_images: [{}, {}, {}] })).toBe(false);
  });
});
