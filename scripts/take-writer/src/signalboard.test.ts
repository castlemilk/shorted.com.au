import { describe, it, expect, vi } from "vitest";
import { lastTakeDateForStock } from "./journalism.js";

describe("lastTakeDateForStock", () => {
  it("returns the most recent created_at for a stock, or null", async () => {
    const pg = { query: vi.fn().mockResolvedValue({ rows: [{ last: "2026-05-20" }] }) } as any;
    expect(await lastTakeDateForStock(pg, "BHP")).toBe("2026-05-20");
  });
  it("returns null when no take exists", async () => {
    const pg = { query: vi.fn().mockResolvedValue({ rows: [] }) } as any;
    expect(await lastTakeDateForStock(pg, "BHP")).toBeNull();
  });
});
