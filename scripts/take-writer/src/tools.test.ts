import { describe, it, expect, vi } from "vitest";
import { TOOL_DEFS, dispatchTool } from "./tools.js";
import { CitationLedger } from "./ledger.js";

describe("TOOL_DEFS", () => {
  it("declares the expected tools with input schemas", () => {
    const names = TOOL_DEFS.map((t) => t.name).sort();
    expect(names).toEqual(
      ["align_events", "follow_peer", "news_detail", "report_line", "search_news", "zoom_window"].sort(),
    );
    for (const t of TOOL_DEFS) {
      expect(t.input_schema.type).toBe("object");
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
});
