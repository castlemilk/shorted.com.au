import { describe, expect, it } from "vitest";
import { buildRunHeroPrompt } from "./run.js";
import { EDITORIAL_CRAFT_RULES } from "./editorial-art-policy.js";

describe("on-demand article artwork", () => {
  it("grounds the hero in the drafted argument and shares the newsroom's craft criteria", () => {
    const body = "Vendors trim advertised sale prices; the sample does not measure settled values.";
    const prompt = buildRunHeroPrompt("Advertised price revisions", "ASX", body);
    expect(prompt).toContain(body);
    expect(prompt).toContain("Article headline: Advertised price revisions");
    expect(prompt).toContain(EDITORIAL_CRAFT_RULES);
    expect(prompt).toContain("16:9");
    expect(prompt).toContain("Choose light or dark grounds according to the story");
    expect(prompt).toContain("Relevant Australian building forms are welcome");
    expect(prompt).not.toMatch(/Visual style: dark background|Do NOT add any city skylines or recognisable architecture|isometric\/geometric data abstraction|single warm amber light source/);
  });

  it("bounds article context while keeping final image constraints after it", () => {
    const prompt = buildRunHeroPrompt("Research findings", "ASX", `${"x".repeat(4_000)}unbounded-tail`);
    expect(prompt).not.toContain("unbounded-tail");
    expect(prompt).toContain("STRICT: no text, letters, numbers");
    expect(prompt.indexOf("STRICT:")).toBeGreaterThan(prompt.indexOf("Article body,"));
  });
});
