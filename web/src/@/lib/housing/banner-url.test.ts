/// <reference types="jest" />

import { safeBannerUrl } from "./banner-url";

describe("safeBannerUrl", () => {
  it("accepts our own root-relative assets", () => {
    expect(safeBannerUrl("/housing-banners/bg/coastal-beach.light.avif")).toBe(
      "/housing-banners/bg/coastal-beach.light.avif",
    );
  });

  it("accepts https on an allowlisted host", () => {
    expect(safeBannerUrl("https://storage.googleapis.com/shorted/banners/x.avif")).toBe(
      "https://storage.googleapis.com/shorted/banners/x.avif",
    );
  });

  it("rejects an arbitrary third-party host", () => {
    expect(safeBannerUrl("https://evil.example/pixel.gif")).toBeNull();
  });

  it("rejects a protocol-relative URL rather than treating it as a path", () => {
    expect(safeBannerUrl("//evil.example/pixel.gif")).toBeNull();
  });

  it("rejects non-https schemes", () => {
    expect(safeBannerUrl("http://storage.googleapis.com/x.avif")).toBeNull();
    expect(safeBannerUrl("data:image/svg+xml,<svg/>")).toBeNull();
    expect(safeBannerUrl("javascript:alert(1)")).toBeNull();
  });

  it("rejects a lookalike host", () => {
    expect(safeBannerUrl("https://storage.googleapis.com.evil.example/x")).toBeNull();
  });

  it("treats empty and whitespace as absent", () => {
    expect(safeBannerUrl("")).toBeNull();
    expect(safeBannerUrl("   ")).toBeNull();
    expect(safeBannerUrl(undefined)).toBeNull();
  });
});
