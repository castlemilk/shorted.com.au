import { describe, it, expect, vi } from "vitest";
import { investigate, type MessagesCreate } from "./investigator.js";
import { CitationLedger } from "./ledger.js";

const assignment = { stockCode: "DRO", industry: null, angle: "Probe vs shorts", tier: "take" as const, rationale: "x" };

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

  it("nudges once on a text-only stop, then finalises on emit_dossier", async () => {
    const pg = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    const create = vi.fn()
      .mockResolvedValueOnce({ stop_reason: "end_turn", content: [{ type: "text", text: "I think the probe matters." }] })
      .mockResolvedValueOnce({ stop_reason: "tool_use", content: [{ type: "tool_use", id: "t2", name: "emit_dossier", input: { summary: "Done.", threads: [], keyNumbers: [] } }] });
    const ledger = new CitationLedger();
    const dossier = await investigate(create as any, pg, assignment, ledger, { maxTurns: 4, model: "claude-sonnet-4-6" });
    expect(dossier.summary).toBe("Done.");
    expect(create.mock.calls.length).toBe(2);
  });

  it("sanitises malformed emit_dossier output (non-array threads, bad summary)", async () => {
    const pg = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    const create = vi.fn().mockResolvedValueOnce({
      stop_reason: "tool_use",
      content: [{ type: "tool_use", id: "t1", name: "emit_dossier", input: { summary: 42, threads: "nope", keyNumbers: [{ label: "x", value: "1" }, { bad: true }] } }],
    });
    const ledger = new CitationLedger();
    const dossier = await investigate(create as any, pg, assignment, ledger, { maxTurns: 4, model: "claude-sonnet-4-6" });
    expect(dossier.threads).toEqual([]);          // non-array dropped
    expect(dossier.summary).toBe(assignment.angle); // non-string summary -> angle fallback
    expect(dossier.keyNumbers.length).toBe(1);     // only the well-formed keyNumber kept
  });

  it("defaults missing refIds to [] on timeline items", async () => {
    const pg = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    const create = vi.fn().mockResolvedValueOnce({
      stop_reason: "tool_use",
      content: [{ type: "tool_use", id: "t1", name: "emit_dossier", input: {
        summary: "s", threads: [], keyNumbers: [],
        timeline: [{ date: "2026-05-01", event: "probe opened" }],  // no refIds
      } }],
    });
    const ledger = new CitationLedger();
    const d = await investigate(create as any, pg, { ...assignment, tier: "deep_dive" as const }, ledger, { maxTurns: 4, model: "claude-opus-4-8" });
    expect(d.timeline![0]!.refIds).toEqual([]);
  });
});
