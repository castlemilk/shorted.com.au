import { describe, it, expect, vi } from "vitest";
import { GEMINI_TOOL_DECLS, dispatchTool } from "./tools.js";
import { SchemaType } from "@google/generative-ai";
import { CitationLedger } from "./ledger.js";

describe("GEMINI_TOOL_DECLS", () => {
  it("declares the expected tools with object parameter schemas", () => {
    const names = GEMINI_TOOL_DECLS.map((t) => t.name).sort();
    expect(names).toEqual(["align_events", "follow_peer", "get_financials", "get_overview", "news_detail", "report_line", "search_news", "zoom_window"].sort());
    for (const t of GEMINI_TOOL_DECLS) {
      expect(t.parameters?.type).toBe(SchemaType.OBJECT);
    }
  });
});

describe("dispatchTool", () => {
  it("runs search_news and registers each returned source in the ledger", async () => {
    const ledger = new CitationLedger();
    const pg = {
      query: vi.fn().mockResolvedValue({
        rows: [{ id: "1", date: "2026-05-01", source: "Stockhead", headline: "Probe", url: "https://x/1" }],
      }),
    };
    const out = await dispatchTool(pg, ledger, "search_news", { query: "probe", code: "DRO" });
    expect(ledger.size()).toBe(1);
    expect(ledger.has("ref-1")).toBe(true);
    // The agent-facing result embeds the refId so the model can cite it.
    expect(out).toContain("ref-1");
    expect(out).toContain("Probe");
  });

  it("returns an error string for an unknown tool instead of throwing", async () => {
    const ledger = new CitationLedger();
    const pg = { query: vi.fn() };
    const out = await dispatchTool(pg, ledger, "nope", {});
    expect(out.toLowerCase()).toContain("unknown tool");
  });

  it("runs get_overview and registers NO sources (data, not citations)", async () => {
    const ledger = new CitationLedger();
    const pg = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    const out = await dispatchTool(pg, ledger, "get_overview", {}, "BHP");
    expect(ledger.size()).toBe(0);
    expect(() => JSON.parse(out)).not.toThrow();
    expect(out).toContain("currentShortPct");
  });
});
