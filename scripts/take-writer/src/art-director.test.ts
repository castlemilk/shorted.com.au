import { describe, expect, it, vi } from "vitest";
import type { GoogleGenerativeAI } from "@google/generative-ai";
import { designImagePlan, normalisePlanRoles, STYLE_PROMPTS, type PlanItem } from "./art-director.js";
import { EDITORIAL_CRAFT_RULES } from "./editorial-art-policy.js";

function item(over: Partial<PlanItem> = {}): PlanItem {
  return {
    role: "inline",
    style: "documentary",
    ratio: "square",
    brief: "a drill core tray at the Kayelekera mine",
    caption: "Core samples, Kayelekera",
    placement: "inset",
    anchorAfterBlock: 1,
    ...over,
  };
}

describe("normalisePlanRoles", () => {
  it("returns [] for an empty plan", () => {
    expect(normalisePlanRoles([])).toEqual([]);
  });

  it("keeps a single hero, moved to index 0, forced landscape", () => {
    const plan = [
      item({ brief: "a" }),
      item({ role: "hero", ratio: "portrait", brief: "b" }),
      item({ brief: "c" }),
    ];
    const out = normalisePlanRoles(plan);
    expect(out).toHaveLength(3);
    expect(out[0]!.role).toBe("hero");
    expect(out[0]!.brief).toBe("b");
    expect(out[0]!.ratio).toBe("landscape");
    expect(out.filter((i) => i.role === "hero")).toHaveLength(1);
    // inline order + anchors preserved
    expect(out.slice(1).map((i) => i.brief)).toEqual(["a", "c"]);
  });

  it("no hero → promotes the first landscape item and moves it first", () => {
    const plan = [
      item({ brief: "a", ratio: "portrait" }),
      item({ brief: "b", ratio: "landscape" }),
      item({ brief: "c", ratio: "landscape" }),
    ];
    const out = normalisePlanRoles(plan);
    expect(out[0]!.role).toBe("hero");
    expect(out[0]!.brief).toBe("b");
    expect(out[0]!.ratio).toBe("landscape");
    expect(out.filter((i) => i.role === "hero")).toHaveLength(1);
    expect(out.slice(1).every((i) => i.role === "inline")).toBe(true);
  });

  it("no hero and no landscape → promotes the first item and forces landscape", () => {
    const plan = [item({ brief: "a", ratio: "portrait" }), item({ brief: "b", ratio: "square" })];
    const out = normalisePlanRoles(plan);
    expect(out[0]!.role).toBe("hero");
    expect(out[0]!.brief).toBe("a");
    expect(out[0]!.ratio).toBe("landscape");
  });

  it("two heroes → keeps the first, demotes the second to inline", () => {
    const plan = [
      item({ role: "hero", ratio: "landscape", brief: "a" }),
      item({ role: "hero", ratio: "landscape", brief: "b" }),
      item({ brief: "c" }),
    ];
    const out = normalisePlanRoles(plan);
    expect(out.filter((i) => i.role === "hero")).toHaveLength(1);
    expect(out[0]!.brief).toBe("a");
    expect(out.find((i) => i.brief === "b")!.role).toBe("inline");
  });

  it("defaults a missing/garbage role to inline before normalising", () => {
    const plan = [
      item({ brief: "a", ratio: "landscape", role: undefined as unknown as PlanItem["role"] }),
      item({ brief: "b", role: "banner" as unknown as PlanItem["role"] }),
    ];
    const out = normalisePlanRoles(plan);
    expect(out[0]!.role).toBe("hero"); // first landscape promoted
    expect(out[1]!.role).toBe("inline");
  });

  it("does not mutate its input", () => {
    const plan = [item({ brief: "a", ratio: "landscape" })];
    const before = JSON.parse(JSON.stringify(plan));
    normalisePlanRoles(plan);
    expect(plan).toEqual(before);
  });
});

describe("editorial art direction", () => {
  it("supports new tactile presets and preserves every legacy style key", () => {
    for (const key of ["paper_collage", "printmaking", "documentary", "aerial", "still_life", "isometric", "archival", "abstract", "environmental"]) {
      expect(STYLE_PROMPTS[key]).toMatch(/illustration|editorial art|editorial still life/i);
    }
    expect(STYLE_PROMPTS.paper_collage).toContain("visual action");
    expect(STYLE_PROMPTS.printmaking).toContain("thumbnail size");
    expect(STYLE_PROMPTS.still_life).toContain("Warm paper");
    expect(STYLE_PROMPTS.documentary).toContain("never an image claiming to document an actual event");
    expect(STYLE_PROMPTS.archival).toContain("never a fabricated historical photograph");
  });

  it("requests illustrative captions and accepts new presets through the real planner normalisation", async () => {
    const images = [
      item({ style: "printmaking", brief: "A queue of share tiles passing through a narrow gate", caption: "Illustration: a narrow exit for crowded positions", anchorAfterBlock: 50 }),
      item({ role: "hero", style: "paper_collage", brief: "A paper house's blank price tag trimmed by scissors", caption: "Illustration: advertised prices being trimmed", ratio: "portrait" }),
    ];
    const generateContent = vi.fn().mockResolvedValue({ response: { text: () => JSON.stringify({ images }) } });
    const getGenerativeModel = vi.fn().mockReturnValue({ generateContent });
    const ai = { getGenerativeModel } as unknown as GoogleGenerativeAI;

    const plan = await designImagePlan(ai, {
      stockCode: "ASX",
      headline: "Vendors revise asking prices",
      industry: "Real estate",
      description: "Advertised asking prices, not settled sale prices",
      bodyMd: "First block\n\nSecond block\n\nThird block\n\nFourth block",
    }, 2);

    const config = getGenerativeModel.mock.calls[0]![0];
    expect(config.systemInstruction).toContain("default to paper_collage or still_life");
    expect(config.systemInstruction).toContain("Every caption begins 'Illustration:'");
    expect(config.systemInstruction).toContain("never fabricate photojournalism");
    expect(config.systemInstruction).toContain("Choose light or dark grounds");
    expect(config.systemInstruction).toContain(EDITORIAL_CRAFT_RULES);
    const imageSchema = config.generationConfig.responseSchema.properties.images.items.properties;
    expect(imageSchema.style.enum).toEqual(expect.arrayContaining(["paper_collage", "printmaking", "documentary"]));
    expect(imageSchema.caption.description).toContain("beginning 'Illustration:'");
    expect(generateContent.mock.calls[0]![0]).toContain("Advertised asking prices, not settled sale prices");
    expect(generateContent.mock.calls[0]![0]).toContain("[0] First block\n[1] Second block\n[2] Third block\n[3] Fourth block");
    expect(plan.map((image) => image.style)).toEqual(["paper_collage", "printmaking"]);
    expect(plan[0]!.role).toBe("hero");
    expect(plan[0]!.ratio).toBe("landscape");
    expect(plan[1]!.anchorAfterBlock).toBe(2);
    expect(plan[1]!.caption).toBe(images[0]!.caption);
  });

  it.each([3, 80])("shares a bounded body budget across all %i article blocks", async (blockCount) => {
    const generateContent = vi.fn().mockResolvedValue({ response: { text: () => JSON.stringify({ images: [] }) } });
    const ai = { getGenerativeModel: vi.fn().mockReturnValue({ generateContent }) } as unknown as GoogleGenerativeAI;
    const bodyMd = Array.from({ length: blockCount }, (_, i) => `Section ${i}: ${"x".repeat(2_000)}`).join("\n\n");

    await designImagePlan(ai, {
      stockCode: "ASX",
      headline: "A long investigation",
      industry: null,
      description: null,
      bodyMd,
    }, 2);

    const prompt = generateContent.mock.calls[0]![0] as string;
    const excerpts = prompt.match(/Article body excerpts by block \(each may be truncated\):\n([\s\S]*?)\nDesign 2 images/)![1]!;
    expect(excerpts.length).toBeLessThanOrEqual(16_000);
    expect(excerpts.split("\n")).toHaveLength(blockCount);
    expect(excerpts).toContain("[0] Section 0:");
    const middle = Math.floor(blockCount / 2);
    const final = blockCount - 1;
    expect(excerpts).toContain(`[${middle}] Section ${middle}:`);
    expect(excerpts).toContain(`[${final}] Section ${final}:`);
    for (const line of excerpts.split("\n")) {
      expect(line.replace(/^\[\d+\] /, "").length).toBeLessThanOrEqual(400);
    }
  });
});
