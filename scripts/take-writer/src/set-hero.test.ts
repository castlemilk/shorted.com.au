import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkHeroImage, heroObjectPath, imageDimensions, setHero } from "./set-hero.js";

const mocks = vi.hoisted(() => ({
  pg: { connect: vi.fn(), query: vi.fn(), end: vi.fn() },
  save: vi.fn(), file: vi.fn(), bucket: vi.fn(),
  validate: vi.fn(), revalidate: vi.fn(), readFile: vi.fn(),
}));
vi.mock("pg", () => ({ Client: vi.fn(() => mocks.pg) }));
vi.mock("@google-cloud/storage", () => ({ Storage: vi.fn(() => ({ bucket: mocks.bucket })) }));
vi.mock("node:fs/promises", () => ({ readFile: mocks.readFile }));
vi.mock("./publish.js", () => ({ revalidateNewsSurfaces: mocks.revalidate }));
vi.mock("./validator.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./validator.js")>()),
  validateArticle: mocks.validate,
}));

/** A PNG header (signature + IHDR) of the given size; enough for sniffing and sizing. */
function png(width: number, height: number): Buffer {
  const b = Buffer.alloc(33);
  Buffer.from("89504e470d0a1a0a", "hex").copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "latin1");
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}
/** An extended-format WebP header (VP8X) of the given size. */
function webp(width: number, height: number): Buffer {
  const b = Buffer.alloc(30);
  b.write("RIFF", 0, "latin1");
  b.writeUInt32LE(22, 4);
  b.write("WEBPVP8X", 8, "latin1");
  b.writeUInt32LE(10, 16);
  b.writeUIntLE(width - 1, 24, 3);
  b.writeUIntLE(height - 1, 27, 3);
  return b;
}
/** A JPEG with one APP0 segment before its baseline start-of-frame. */
function jpeg(width: number, height: number): Buffer {
  const app0 = [0xff, 0xe0, 0x00, 0x10, ...Buffer.from("JFIF\0"), 1, 1, 0, 0, 1, 0, 1, 0, 0];
  const sof = [0xff, 0xc0, 0x00, 0x11, 8, height >> 8, height & 0xff, width >> 8, width & 0xff, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
  return Buffer.from([0xff, 0xd8, ...app0, ...sof, 0xff, 0xd9]);
}
// 1×1 lossless WebP (VP8L), the validator tests' fixture.
const VP8L = Buffer.from("UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==", "base64");

const OLD = "https://storage.googleapis.com/shorted-company-logos-prod/takes/zip-slug-hero.png";
const CAPTION = "Illustration: An amber zip pull slides down over dark tiles.";
const IMAGE = webp(1536, 1024);
const SHA12 = createHash("sha256").update(IMAGE).digest("hex").slice(0, 12);
const NEW = `https://storage.googleapis.com/shorted-company-logos-prod/takes/zip-slug-hero-${SHA12}.webp`;
const take = (published = true) => ({ published_at: published ? "2026-11-09T06:00:00Z" : null, hero_image_url: OLD });
const run = (extra: Partial<Parameters<typeof setHero>[0]> = {}) => setHero({ slug: "zip-slug", imagePath: "/tmp/zip.webp", caption: CAPTION, ...extra });

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("DATABASE_URL", "postgresql://offline:offline@127.0.0.1:65535/offline");
  vi.stubEnv("GCS_LOGO_BUCKET", "shorted-company-logos-prod");
  mocks.readFile.mockResolvedValue(IMAGE);
  mocks.bucket.mockReturnValue({ file: mocks.file });
  mocks.file.mockReturnValue({ save: mocks.save });
  mocks.save.mockResolvedValue(undefined);
  mocks.validate.mockResolvedValue(undefined);
  mocks.revalidate.mockResolvedValue(undefined);
  mocks.pg.query.mockImplementation(async (sql: string) => (sql.trimStart().startsWith("SELECT") ? { rows: [take()] } : { rowCount: 1, rows: [] }));
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("image checks", () => {
  it("reads the size of PNG, WebP (VP8X and VP8L) and JPEG headers", () => {
    expect(imageDimensions(png(1536, 1024), "image/png")).toEqual({ width: 1536, height: 1024 });
    expect(imageDimensions(webp(1536, 1024), "image/webp")).toEqual({ width: 1536, height: 1024 });
    expect(imageDimensions(VP8L, "image/webp")).toEqual({ width: 1, height: 1 });
    expect(imageDimensions(jpeg(1600, 900), "image/jpeg")).toEqual({ width: 1600, height: 900 });
  });
  it("accepts a large landscape image and refuses portrait, small or unknown files", () => {
    expect(checkHeroImage(webp(1536, 1024))).toEqual({ type: "image/webp", width: 1536, height: 1024 });
    expect(() => checkHeroImage(png(1024, 1536))).toThrow(/landscape/);
    expect(() => checkHeroImage(png(800, 450))).toThrow(/at least 1200px/);
    expect(() => checkHeroImage(Buffer.from("GIF89a-not-a-hero"))).toThrow(/PNG, WebP or JPEG/);
  });
  it("names the object by its content, so a new image never reuses a URL", () => {
    expect(heroObjectPath("zip-slug", IMAGE, "image/webp")).toBe(`takes/zip-slug-hero-${SHA12}.webp`);
    expect(heroObjectPath("zip-slug", png(1536, 1024), "image/png")).not.toContain(SHA12);
  });
});

describe("set-hero", () => {
  it("uploads under the content-addressed name, reviews the candidate, then swaps it in with a guard", async () => {
    const result = await run();
    expect(mocks.file).toHaveBeenCalledWith(`takes/zip-slug-hero-${SHA12}.webp`);
    expect(mocks.save).toHaveBeenCalledWith(IMAGE, expect.objectContaining({ contentType: "image/webp", metadata: { cacheControl: "public, max-age=31536000, immutable" } }));
    expect(mocks.validate).toHaveBeenCalledWith("zip-slug", { rounds: 1, requirePass: true, hero: { url: NEW, caption: CAPTION } });
    const update = mocks.pg.query.mock.calls.findIndex(([sql]) => /UPDATE editorial_takes/.test(sql));
    expect(mocks.pg.query.mock.calls[update]![1]).toEqual([NEW, CAPTION, "AI-generated illustration", "zip-slug", OLD]);
    expect(mocks.pg.query.mock.calls[update]![0]).toMatch(/hero_image_url IS NOT DISTINCT FROM \$5/);
    expect(mocks.save.mock.invocationCallOrder[0]).toBeLessThan(mocks.validate.mock.invocationCallOrder[0]!);
    expect(mocks.validate.mock.invocationCallOrder[0]).toBeLessThan(mocks.pg.query.mock.invocationCallOrder[update]!);
    expect(mocks.revalidate).toHaveBeenCalledWith("zip-slug");
    expect(result).toMatchObject({ previousHeroUrl: OLD, heroUrl: NEW, published: true, dryRun: false });
  });
  it("keeps the previous hero when the review fails", async () => {
    mocks.validate.mockRejectedValue(new Error("cohesion 5/10 below 7"));
    await expect(run()).rejects.toThrow(/header review failed; the take still has its previous hero/);
    expect(mocks.pg.query.mock.calls.some(([sql]) => /UPDATE/.test(sql))).toBe(false);
    expect(mocks.revalidate).not.toHaveBeenCalled();
    expect(mocks.pg.end).toHaveBeenCalledOnce();
  });
  it("writes nothing when the hero changed while the review ran", async () => {
    mocks.pg.query.mockImplementation(async (sql: string) => (sql.trimStart().startsWith("SELECT") ? { rows: [take()] } : { rowCount: 0, rows: [] }));
    await expect(run()).rejects.toThrow(/changed during the review; nothing written/);
    expect(mocks.revalidate).not.toHaveBeenCalled();
  });
  it("swaps a draft's hero without revalidating public pages", async () => {
    mocks.pg.query.mockImplementation(async (sql: string) => (sql.trimStart().startsWith("SELECT") ? { rows: [take(false)] } : { rowCount: 1, rows: [] }));
    await run();
    expect(mocks.validate).toHaveBeenCalledOnce();
    expect(mocks.revalidate).not.toHaveBeenCalled();
  });
  it("dry run uploads nothing, reviews nothing and writes nothing", async () => {
    const result = await run({ dryRun: true });
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.validate).not.toHaveBeenCalled();
    expect(mocks.pg.query).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ heroUrl: NEW, dryRun: true });
  });
  it("refuses a caption that is not an illustration caption before reading anything", async () => {
    await expect(run({ caption: "A photo of the zip" })).rejects.toThrow(/begin "Illustration:"/);
    expect(mocks.readFile).not.toHaveBeenCalled();
    expect(mocks.pg.connect).not.toHaveBeenCalled();
  });
  it("refuses an unusable image before connecting or uploading", async () => {
    mocks.readFile.mockResolvedValue(png(1024, 1536));
    await expect(run()).rejects.toThrow(/landscape/);
    expect(mocks.pg.connect).not.toHaveBeenCalled();
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it("refuses an image that is already the take's hero", async () => {
    mocks.pg.query.mockImplementation(async () => ({ rows: [{ ...take(), hero_image_url: NEW }] }));
    await expect(run()).rejects.toThrow(/already the take's hero/);
    expect(mocks.save).not.toHaveBeenCalled();
  });
});
