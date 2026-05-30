import { describe, it, expect, vi } from "vitest";
import { investigate, type MessagesCreate } from "./investigator.js";
import { CitationLedger } from "./ledger.js";

const assignment = { stockCode: "DRO", angle: "Probe vs shorts", tier: "take" as const, rationale: "x" };

describe("investigate", () => {
  it("runs a tool round then finalises the dossier from emit_dossier", async () => {
    const pg = { query: vi.fn().mockResolvedValue({ rows: [{ id: "1", date: "2026-05-01", source: "S", headline: "Probe opened", url: "https://x/1" }] }) };
    const create: MessagesCreate = vi.fn()
      // round 1: call a tool
      .mockResolvedValueOnce({
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "t1", name: "search_news", input: { query: "probe" } }],
      })
      // round 2: emit the dossier via the emit_dossier tool
      .mockResolvedValueOnce({
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "t2", name: "emit_dossier", input: {
          summary: "ASIC opened a probe; shorts held.",
          threads: [{ claim: "Probe opened 1 May", evidenceRefIds: ["ref-1"] }],
          keyNumbers: [{ label: "short %", value: "14%" }],
        } }],
      });

    const ledger = new CitationLedger();
    const dossier = await investigate(create as MessagesCreate, pg, assignment, ledger, { maxTurns: 6, model: "claude-sonnet-4-6" });
    expect(dossier.summary).toContain("probe");
    expect(dossier.threads[0]!.evidenceRefIds).toEqual(["ref-1"]);
    expect(ledger.size()).toBe(1); // search_news registered the source
    expect((create as any).mock.calls.length).toBe(2);
  });

  it("finalises a minimal dossier if the turn cap is hit without emit_dossier", async () => {
    const pg = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    const create: MessagesCreate = vi.fn().mockResolvedValue({
      stop_reason: "tool_use",
      content: [{ type: "tool_use", id: "t", name: "align_events", input: {} }],
    });
    const ledger = new CitationLedger();
    const dossier = await investigate(create as MessagesCreate, pg, assignment, ledger, { maxTurns: 2, model: "claude-sonnet-4-6" });
    expect(dossier.stockCode).toBe("DRO");
    expect(Array.isArray(dossier.threads)).toBe(true);
    expect((create as any).mock.calls.length).toBe(2); // stopped at the cap
  });
});
