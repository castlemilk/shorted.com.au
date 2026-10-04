import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { importMdx, publishContent } from "./import-mdx.js";

const mocks = vi.hoisted(() => ({ pg: { connect: vi.fn(), query: vi.fn(), end: vi.fn() }, publish: vi.fn() }));
vi.mock("pg", () => ({ Client: vi.fn(() => mocks.pg) }));
vi.mock("./publish.js", () => ({ publishTake: mocks.publish }));
let dir: string;
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("DATABASE_URL", "postgresql://offline:offline@127.0.0.1:65535/offline");
  dir = mkdtempSync(join(tmpdir(), "publication-guard-"));
  writeFileSync(join(dir, "article.mdx"), '---\nslug: "reviewed-slug"\nheadline: "Reviewed headline"\nogImageUrl: "https://shorted.com.au/cover.png"\n---\n\nReviewed body.\n');
  mocks.pg.query.mockResolvedValue({ rows: [{ slug: "reviewed-slug", published_at: null }] });
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
describe("content publication entrypoint", () => {
  it("rejects legacy bulk publication before any article write", async () => {
    await expect(importMdx({ file: join(dir, "article.mdx"), publish: true })).rejects.toThrow(/creates drafts/);
    expect(mocks.pg.connect).not.toHaveBeenCalled();
    expect(mocks.publish).not.toHaveBeenCalled();
  });
  it("rejects --no-validate before an article import or paid call", async () => {
    await expect(publishContent({ slug: "reviewed-slug", dir, noImages: true, noValidate: true })).rejects.toThrow(/requires vision validation/);
    expect(mocks.pg.connect).not.toHaveBeenCalled();
    expect(mocks.publish).not.toHaveBeenCalled();
  });
  it("imports a draft and forwards the preserved-cover mode without a tweet or validation bypass", async () => {
    await publishContent({ slug: "reviewed-slug", dir, noImages: true });
    expect(mocks.pg.query.mock.calls[0]![0]).toMatch(/WHERE editorial_takes\.published_at IS NULL\s+RETURNING slug/);
    expect(mocks.publish).toHaveBeenCalledWith({ slug: "reviewed-slug", noImages: true, noValidate: undefined });
  });
  it("does not invoke publication when a live row prevents draft-only import", async () => {
    mocks.pg.query.mockResolvedValue({ rows: [] });
    await expect(publishContent({ slug: "reviewed-slug", dir, noImages: true })).rejects.toThrow(/cannot overwrite a published article/);
    expect(mocks.publish).not.toHaveBeenCalled();
    expect(mocks.pg.end).toHaveBeenCalledOnce();
  });
});
