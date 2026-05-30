import { describe, it, expect, vi } from "vitest";
import { investigate, type GeminiGenerate } from "./investigator.js";
import { CitationLedger } from "./ledger.js";

const assignment = { stockCode: "DRO", industry: null, angle: "Probe vs shorts", tier: "take" as const, rationale: "x" };

// Build a GeminiTurn from a list of {name,args} function calls.
const turn = (calls: Array<{ name: string; args: Record<string, unknown> }>) => ({
  functionCalls: () => (calls.length ? calls : undefined),
  modelContent: () => ({ role: "model" as const, parts: calls.map((c) => ({ functionCall: { name: c.name, args: c.args } })) }),
});
const textTurn = () => ({
  functionCalls: () => undefined,
  modelContent: () => ({ role: "model" as const, parts: [{ text: "thinking..." }] }),
});

describe("investigate", () => {
  it("runs a tool round then finalises from emit_dossier", async () => {
    const pg = { query: vi.fn().mockResolvedValue({ rows: [{ id: "1", date: "2026-05-01", source: "S", headline: "Probe opened", url: "https://x/1" }] }) };
    const generate: GeminiGenerate = vi.fn()
      .mockResolvedValueOnce(turn([{ name: "search_news", args: { query: "probe" } }]))
      .mockResolvedValueOnce(turn([{ name: "emit_dossier", args: { summary: "ASIC opened a probe; shorts held.", threads: [{ claim: "Probe opened 1 May", evidenceRefIds: ["ref-1"] }], keyNumbers: [{ label: "short %", value: "14%" }] } }]));
    const ledger = new CitationLedger();
    const d = await investigate(generate, pg, assignment, ledger, { maxTurns: 6 });
    expect(d.summary).toContain("probe");
    expect(d.threads[0]!.evidenceRefIds).toEqual(["ref-1"]);
    expect(ledger.size()).toBe(1);
    expect((generate as any).mock.calls.length).toBe(2);
  });

  it("finalises minimally when the turn cap is hit without emit_dossier", async () => {
    const pg = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    const generate: GeminiGenerate = vi.fn().mockResolvedValue(turn([{ name: "align_events", args: {} }]));
    const ledger = new CitationLedger();
    const d = await investigate(generate, pg, assignment, ledger, { maxTurns: 2 });
    expect(d.stockCode).toBe("DRO");
    expect(Array.isArray(d.threads)).toBe(true);
    expect((generate as any).mock.calls.length).toBe(2);
  });

  it("nudges once on a text-only turn, then finalises on emit_dossier", async () => {
    const pg = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    const generate: GeminiGenerate = vi.fn()
      .mockResolvedValueOnce(textTurn())
      .mockResolvedValueOnce(turn([{ name: "emit_dossier", args: { summary: "Done.", threads: [], keyNumbers: [] } }]));
    const ledger = new CitationLedger();
    const d = await investigate(generate, pg, assignment, ledger, { maxTurns: 4 });
    expect(d.summary).toBe("Done.");
    expect((generate as any).mock.calls.length).toBe(2);
  });

  it("sanitises malformed emit_dossier output", async () => {
    const pg = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    const generate: GeminiGenerate = vi.fn().mockResolvedValueOnce(turn([{ name: "emit_dossier", args: { summary: 42, threads: "nope", keyNumbers: [{ label: "x", value: "1" }, { bad: true }] } }]));
    const ledger = new CitationLedger();
    const d = await investigate(generate, pg, { ...assignment }, ledger, { maxTurns: 4 });
    expect(d.threads).toEqual([]);
    expect(d.summary).toBe(assignment.angle);
    expect(d.keyNumbers.length).toBe(1);
  });

  it("defaults missing refIds to [] on timeline items", async () => {
    const pg = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    const generate: GeminiGenerate = vi.fn().mockResolvedValueOnce(turn([{ name: "emit_dossier", args: { summary: "s", threads: [], keyNumbers: [], timeline: [{ date: "2026-05-01", event: "probe opened" }] } }]));
    const ledger = new CitationLedger();
    const d = await investigate(generate, pg, { ...assignment, tier: "deep_dive" as const }, ledger, { maxTurns: 4 });
    expect(d.timeline![0]!.refIds).toEqual([]);
  });
});
