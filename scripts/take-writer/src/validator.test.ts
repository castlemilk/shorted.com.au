import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PUBLICATION_VISION_LIMITS, validateArticle } from "./validator.js";

const mocks = vi.hoisted(() => ({
  pg: { connect: vi.fn(), query: vi.fn(), end: vi.fn() },
  generateContent: vi.fn(), countTokens: vi.fn(), getModel: vi.fn(),
  generateHero: vi.fn(), generateLayout: vi.fn(),
}));
vi.mock("pg", () => ({ Client: vi.fn(() => mocks.pg) }));
vi.mock("@google/generative-ai", () => ({
  SchemaType: { OBJECT: "object", NUMBER: "number", STRING: "string", BOOLEAN: "boolean", ARRAY: "array" },
  GoogleGenerativeAI: vi.fn(() => ({ getGenerativeModel: mocks.getModel })),
}));
vi.mock("openai", () => ({ default: vi.fn(() => ({})) }));
vi.mock("@google-cloud/storage", () => ({ Storage: vi.fn(() => ({})) }));
vi.mock("./art-director.js", () => ({ generatePlanHero: mocks.generateHero, generateOneLayoutImage: mocks.generateLayout }));

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP1sAAAAASUVORK5CYII=", "base64");
const goodImage = { fits: true, captionAccurate: true, qualityOk: true, issue: "", regenerate: false, newBrief: "", newCaption: "" };
const goodVerdict = () => ({ cohesionScore: 8, layoutNotes: "Per-image review", verdict: "Cohesive", hero: { ...goodImage }, images: [] });
const row = () => ({ headline: "Reviewed headline", body_md: "Reviewed text", layout_images: [], hero_image_url: "https://shorted.com.au/cover.png", hero_caption: null });
let fetchMock: ReturnType<typeof vi.fn>;

function reply(verdict: unknown = goodVerdict(), finishReason = "STOP") {
  return { response: { candidates: [{ finishReason }], text: () => JSON.stringify(verdict), usageMetadata: { promptTokenCount: 3000, candidatesTokenCount: 500, totalTokenCount: 3500 } } };
}
const validate = () => validateArticle("reviewed-slug", { rounds: 1, requirePass: true });

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("DATABASE_URL", "postgresql://offline:offline@127.0.0.1:65535/offline");
  vi.stubEnv("GEMINI_API_KEY", "offline-test-key");
  vi.stubEnv("OPENAI_API_KEY", "offline-test-key");
  vi.stubEnv("VALIDATOR_MODEL", "an-unapproved-model");
  mocks.pg.query.mockResolvedValue({ rows: [row()] });
  mocks.getModel.mockReturnValue({ generateContent: mocks.generateContent, countTokens: mocks.countTokens });
  mocks.countTokens.mockResolvedValue({ totalTokens: 3000 });
  mocks.generateContent.mockResolvedValue(reply());
  fetchMock = vi.fn(async () => new Response(PNG, { headers: { "content-type": "image/png" } }));
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("required publication vision review", () => {
  it("sends the schema and caps through the real SDK in both count and inference requests", async () => {
    const sdk = await vi.importActual<typeof import("@google/generative-ai")>("@google/generative-ai");
    mocks.getModel.mockImplementation((params, options) => new sdk.GoogleGenerativeAI("offline-test-key").getGenerativeModel(params, options));
    const requests: { url: string; body: Record<string, any> }[] = [];
    fetchMock.mockImplementation(async (url: string, options?: RequestInit) => {
      if (url === row().hero_image_url) return new Response(PNG, { headers: { "content-type": "image/png" } });
      requests.push({ url, body: JSON.parse(options!.body as string) });
      if (url.endsWith(":countTokens")) return Response.json({ totalTokens: 3000 });
      if (url.endsWith(":generateContent")) return Response.json({
        candidates: [{ content: { role: "model", parts: [{ text: JSON.stringify(goodVerdict()) }] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 3000, candidatesTokenCount: 500, totalTokenCount: 3500 },
      });
      throw new Error("Unexpected offline request");
    });
    await validate();
    expect(requests.map((r) => r.url)).toEqual([
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:countTokens",
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent",
    ]);
    const counted = requests[0]!.body.generateContentRequest;
    const generated = requests[1]!.body;
    expect(counted.generationConfig).toEqual(generated.generationConfig);
    expect(counted.contents).toEqual(generated.contents);
    expect(generated.generationConfig).toMatchObject({ candidateCount: 1, maxOutputTokens: 8192, responseSchema: expect.any(Object) });
    expect(generated.generationConfig.responseSchema.required).toContain("hero");
  });

  it("pins the model and limits, counts the complete request, and judges the preserved hero once", async () => {
    await validate();
    expect(mocks.getModel).toHaveBeenCalledWith(expect.objectContaining({
      model: "gemini-3.5-flash",
      generationConfig: expect.objectContaining({ candidateCount: 1, maxOutputTokens: 8192, responseSchema: expect.any(Object) }),
    }), { timeout: 120000 });
    expect(mocks.countTokens).toHaveBeenCalledTimes(1);
    expect(mocks.generateContent).toHaveBeenCalledTimes(1);
    const input = mocks.generateContent.mock.calls[0]![0];
    expect(mocks.countTokens).toHaveBeenCalledWith(input);
    expect(input).toHaveLength(2);
    expect(input[1].inlineData).toEqual({ mimeType: "image/png", data: PNG.toString("base64") });
    expect(mocks.generateHero).not.toHaveBeenCalled();
    expect(mocks.generateLayout).not.toHaveBeenCalled();
    expect(mocks.pg.end).toHaveBeenCalledOnce();
  });

  it.each([12001, 0, NaN, undefined])("rejects unsafe input-token count %s before inference", async (totalTokens) => {
    mocks.countTokens.mockResolvedValue({ totalTokens });
    await expect(validate()).rejects.toThrow(/token limit|token count/);
    expect(mocks.generateContent).not.toHaveBeenCalled();
  });

  it("accepts the input threshold exactly", async () => {
    mocks.countTokens.mockResolvedValue({ totalTokens: PUBLICATION_VISION_LIMITS.maxInputTokens });
    await validate();
    expect(mocks.generateContent).toHaveBeenCalledOnce();
  });

  it("propagates a token-count failure without inference or retry", async () => {
    mocks.countTokens.mockRejectedValue(new Error("count unavailable"));
    await expect(validate()).rejects.toThrow("count unavailable");
    expect(mocks.countTokens).toHaveBeenCalledOnce();
    expect(mocks.generateContent).not.toHaveBeenCalled();
  });

  it("propagates an inference failure without retry or regeneration", async () => {
    mocks.generateContent.mockRejectedValue(new Error("model unavailable"));
    await expect(validate()).rejects.toThrow("model unavailable");
    expect(mocks.generateContent).toHaveBeenCalledOnce();
    expect(mocks.generateHero).not.toHaveBeenCalled();
  });

  it.each(["MAX_TOKENS", "SAFETY", undefined])("rejects incomplete finish reason %s", async (reason) => {
    const r = reply(); r.response.candidates = [{ finishReason: reason as string }];
    mocks.generateContent.mockResolvedValue(r);
    await expect(validate()).rejects.toThrow(/blocked, truncated or incomplete/);
    expect(mocks.generateContent).toHaveBeenCalledOnce();
  });

  it("rejects malformed JSON", async () => {
    const r = reply(); r.response.text = () => "{";
    mocks.generateContent.mockResolvedValue(r);
    await expect(validate()).rejects.toThrow();
    expect(mocks.generateContent).toHaveBeenCalledOnce();
  });

  it("reports failed image flags without logging model-authored text", async () => {
    const privateText = "DO-NOT-LOG-MODEL-CONTENT";
    mocks.generateContent.mockResolvedValue(reply({ ...goodVerdict(), verdict: privateText, layoutNotes: privateText, hero: { ...goodImage, fits: false, issue: privateText, newBrief: privateText, newCaption: privateText } }));
    await expect(validate()).rejects.toThrow(/article stays draft/);
    const logged = vi.mocked(console.error).mock.calls.flat().join("\n");
    expect(logged).toContain('"reason":"image_review_failed"');
    expect(logged).toContain('"fits":false');
    expect(logged).not.toContain(privateText);
    expect(mocks.generateContent).toHaveBeenCalledOnce();
    expect(mocks.generateHero).not.toHaveBeenCalled();
  });

  it("reports missing schema fields while keeping invalid model values out of logs", async () => {
    const privateText = "DO-NOT-LOG-INVALID-MODEL-VALUE";
    mocks.generateContent.mockResolvedValue(reply({ ...goodVerdict(), hero: { ...goodImage, fits: privateText } }));
    await expect(validate()).rejects.toThrow(/required schema/);
    const logged = vi.mocked(console.error).mock.calls.flat().join("\n");
    expect(logged).toContain('"reason":"invalid_schema"');
    expect(logged).toContain('"hero.fits"');
    expect(logged).not.toContain(privateText);
    expect(mocks.generateContent).toHaveBeenCalledOnce();
  });

  it("reports malformed JSON without echoing the response", async () => {
    const privateText = "DO-NOT-LOG-MALFORMED-RESPONSE{";
    const r = reply(); r.response.text = () => privateText;
    mocks.generateContent.mockResolvedValue(r);
    await expect(validate()).rejects.toThrow(/invalid JSON/);
    const logged = vi.mocked(console.error).mock.calls.flat().join("\n");
    expect(logged).toContain('"reason":"invalid_json"');
    expect(logged).not.toContain("DO-NOT-LOG-MALFORMED-RESPONSE");
    const metadata = vi.mocked(console.error).mock.calls.flat().find((line) => String(line).startsWith("[validate] publication response="));
    expect(JSON.parse(String(metadata).split("response=")[1]!)).toEqual({
      candidateCount: 1, finishReason: "STOP", textBytes: Buffer.byteLength(privateText),
      textSha256: createHash("sha256").update(privateText).digest("hex"),
    });
    expect(mocks.generateContent).toHaveBeenCalledOnce();
  });

  it("distinguishes an unavailable SDK text response without logging its error payload", async () => {
    const privateText = "DO-NOT-LOG-SDK-ERROR-PAYLOAD";
    const r = reply(); r.response.text = () => { throw new Error(privateText); };
    mocks.generateContent.mockResolvedValue(r);
    await expect(validate()).rejects.toThrow(/response text is unavailable/);
    const logged = vi.mocked(console.error).mock.calls.flat().join("\n");
    expect(logged).toContain('"reason":"response_text_unavailable"');
    expect(logged).not.toContain('"reason":"invalid_json"');
    expect(logged).not.toContain(privateText);
    expect(mocks.generateContent).toHaveBeenCalledOnce();
    expect(mocks.generateHero).not.toHaveBeenCalled();
  });

  it("keeps accepted publication verdict text out of diagnostic logs", async () => {
    const privateText = "DO-NOT-LOG-ACCEPTED-MODEL-CONTENT";
    mocks.generateContent.mockResolvedValue(reply({ ...goodVerdict(), verdict: privateText, layoutNotes: privateText, hero: { ...goodImage, newBrief: privateText, newCaption: privateText } }));
    await validate();
    const logged = [...vi.mocked(console.error).mock.calls, ...vi.mocked(console.log).mock.calls].flat().join("\n");
    expect(logged).toContain('publication verdict accepted={"cohesionScore":8,"heroApproved":true,"layoutImageCount":0}');
    expect(logged).not.toContain(privateText);
    expect(mocks.generateContent).toHaveBeenCalledOnce();
    expect(mocks.generateHero).not.toHaveBeenCalled();
  });

  it.each([
    ["missing usage", undefined],
    ["thinking beyond cap", { promptTokenCount: 3000, candidatesTokenCount: 500, totalTokenCount: 12000 }],
    ["inconsistent usage", { promptTokenCount: 3000, candidatesTokenCount: 500, totalTokenCount: 3100 }],
  ])("rejects %s rather than reporting an approved bounded review", async (_name, usageMetadata) => {
    mocks.generateContent.mockResolvedValue({ ...reply(), response: { ...reply().response, usageMetadata } });
    await expect(validate()).rejects.toThrow(/usage/);
    expect(mocks.generateContent).toHaveBeenCalledOnce();
  });

  it.each([
    ["missing hero verdict", { ...goodVerdict(), hero: undefined }],
    ["invalid boolean", { ...goodVerdict(), hero: { ...goodImage, fits: "true" } }],
    ["poor fit", { ...goodVerdict(), hero: { ...goodImage, fits: false } }],
    ["inaccurate caption", { ...goodVerdict(), hero: { ...goodImage, captionAccurate: false } }],
    ["poor quality", { ...goodVerdict(), hero: { ...goodImage, qualityOk: false } }],
    ["regeneration requested", { ...goodVerdict(), hero: { ...goodImage, regenerate: true } }],
    ["unresolved issue", { ...goodVerdict(), hero: { ...goodImage, issue: "Wrong subject" } }],
    ["out-of-range score", { ...goodVerdict(), cohesionScore: 20 }],
    ["poor cohesion", { ...goodVerdict(), cohesionScore: 6 }],
  ])("rejects %s and leaves generation to manual review", async (_name, verdict) => {
    mocks.generateContent.mockResolvedValue(reply(verdict));
    await expect(validate()).rejects.toThrow();
    expect(mocks.generateContent).toHaveBeenCalledOnce();
    expect(mocks.generateHero).not.toHaveBeenCalled();
    expect(mocks.generateLayout).not.toHaveBeenCalled();
  });

  it("retains #685's readable failed checks without model-authored issue text", async () => {
    const issue = "MODEL_ISSUE_CANARY_FOR_CAUSE_LOG";
    mocks.generateContent.mockResolvedValue(reply({
      ...goodVerdict(), cohesionScore: 5,
      hero: { ...goodImage, captionAccurate: false, issue },
    }));
    let rejection: unknown;
    try { await validate(); } catch (error) { rejection = error; }
    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as Error).message).toContain("cohesion 5/10 below 7");
    expect((rejection as Error).message).toContain("hero: caption");
    expect((rejection as Error).message).not.toContain(issue);
    expect(mocks.generateContent).toHaveBeenCalledOnce();
  });

  it.each([
    ["missing verdict", []],
    ["duplicate indices", [{ ...goodImage, index: 0 }, { ...goodImage, index: 0 }]],
    ["out-of-range index", [{ ...goodImage, index: 2 }]],
  ])("rejects layout-image coverage: %s", async (_name, images) => {
    mocks.pg.query.mockResolvedValue({ rows: [{ ...row(), layout_images: [{ url: "https://shorted.com.au/layout.png", caption: "Reviewed", placement: "full", ratio: "landscape" }] }] });
    mocks.generateContent.mockResolvedValue(reply({ ...goodVerdict(), images }));
    await expect(validate()).rejects.toThrow(/every layout image/);
    expect(mocks.generateLayout).not.toHaveBeenCalled();
  });

  it("requires a hero before fetching or invoking the model", async () => {
    mocks.pg.query.mockResolvedValue({ rows: [{ ...row(), hero_image_url: null }] });
    await expect(validate()).rejects.toThrow(/existing hero/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.countTokens).not.toHaveBeenCalled();
  });

  it.each([
    ["HTTP error", () => new Response("not found", { status: 404 })],
    ["HTML response", () => new Response("html", { headers: { "content-type": "text/html" } })],
    ["invalid PNG", () => new Response("invalid", { headers: { "content-type": "image/png" } })],
    ["oversize PNG", () => new Response(Buffer.alloc(PUBLICATION_VISION_LIMITS.maxImageBytes + 1), { headers: { "content-type": "image/png" } })],
  ])("rejects a cover %s before any API call", async (_name, response) => {
    fetchMock.mockImplementation(async () => response());
    await expect(validate()).rejects.toThrow();
    expect(mocks.countTokens).not.toHaveBeenCalled();
    expect(mocks.generateContent).not.toHaveBeenCalled();
  });

  it("propagates a cover-fetch failure instead of omitting the image", async () => {
    fetchMock.mockRejectedValue(new Error("cover unavailable"));
    await expect(validate()).rejects.toThrow("cover unavailable");
    expect(mocks.generateContent).not.toHaveBeenCalled();
  });

  it("rejects multiple publication rounds before connecting to the database", async () => {
    await expect(validateArticle("reviewed-slug", { requirePass: true, rounds: 2 })).rejects.toThrow(/exactly one round/);
    expect(mocks.pg.connect).not.toHaveBeenCalled();
  });
});
