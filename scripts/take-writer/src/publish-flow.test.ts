import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { publishTake } from "./publish.js";

const mocks = vi.hoisted(() => ({
  pg: { connect: vi.fn(), query: vi.fn(), end: vi.fn() }, validate: vi.fn(), generate: vi.fn(), spawn: vi.fn(),
}));
vi.mock("pg", () => ({ Client: vi.fn(() => mocks.pg) }));
vi.mock("./validator.js", () => ({ validateArticle: mocks.validate }));
vi.mock("./newsroom.js", () => ({ regenerateImages: mocks.generate }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
const draft = { slug: "reviewed-slug", published_at: null, hero_image_url: "https://shorted.com.au/cover.png", og_image_url: "https://shorted.com.au/cover.png", layout_images: [], headline: "Reviewed headline", stock_code: "DRO" };
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("DATABASE_URL", "postgresql://offline:offline@127.0.0.1:65535/offline");
  vi.stubEnv("REVALIDATION_SECRET", "offline-revalidation-key");
  mocks.pg.query.mockImplementation(async (sql: string) => ({ rows: sql.startsWith("SELECT") ? [draft] : [{ published_at: "2026-10-04T00:00:00Z" }] }));
  mocks.validate.mockResolvedValue(undefined);
  fetchMock = vi.fn(async () => Response.json({ revalidated: true }));
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("publication after required vision review", () => {
  it("rejects --no-validate before reading the draft or invoking any paid operation", async () => {
    await expect(publishTake({ slug: draft.slug, noImages: true, noValidate: true })).rejects.toThrow(/requires vision validation/);
    expect(mocks.pg.connect).not.toHaveBeenCalled();
    expect(mocks.validate).not.toHaveBeenCalled();
    expect(mocks.generate).not.toHaveBeenCalled();
  });
  it("leaves the draft unpublished and sends no revalidation/tweet when review fails", async () => {
    mocks.validate.mockRejectedValue(new Error("vision unavailable"));
    await expect(publishTake({ slug: draft.slug, noImages: true })).rejects.toThrow(/publish aborted/);
    expect(mocks.pg.query.mock.calls.some(([sql]) => /SET published_at/.test(sql))).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(mocks.generate).not.toHaveBeenCalled();
    expect(mocks.validate).toHaveBeenCalledOnce();
  });
  it("writes published_at only after the bounded review succeeds", async () => {
    await publishTake({ slug: draft.slug, noImages: true });
    expect(mocks.validate).toHaveBeenCalledWith(draft.slug, { rounds: 1, requirePass: true });
    const write = mocks.pg.query.mock.calls.findIndex(([sql]) => /SET published_at/.test(sql));
    expect(write).toBe(1);
    expect(mocks.validate.mock.invocationCallOrder[0]).toBeLessThan(mocks.pg.query.mock.invocationCallOrder[write]!);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(mocks.generate).not.toHaveBeenCalled();
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
  it("does not repeat inference or publication for an already-published take", async () => {
    mocks.pg.query.mockResolvedValue({ rows: [{ ...draft, published_at: "2026-10-03T00:00:00Z" }] });
    await publishTake({ slug: draft.slug, noImages: true });
    expect(mocks.validate).not.toHaveBeenCalled();
    expect(mocks.pg.query).toHaveBeenCalledOnce();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
