import { describe, it, expect } from "vitest";
import { buildDossierPrompt, assembleTakeBody, assembleDeepDiveBody, synthesiseFromDossier, type DossierWriterDeps } from "./narrative.js";
import { CitationLedger } from "./ledger.js";
import type { Dossier } from "./investigator.js";

const ledger = new CitationLedger();
const r1 = ledger.register({ type: "news", url: "https://x/1", source: "S", headline: "Probe opened", date: "2026-05-01" });

const dossier: Dossier = {
  stockCode: "DRO", tier: "take", angle: "Probe vs shorts",
  summary: "ASIC opened a probe; shorts held.",
  threads: [{ claim: `Probe opened on 1 May [${r1}]`, evidenceRefIds: [r1] }],
  keyNumbers: [{ label: "short %", value: "14%", refId: r1 }],
};

describe("buildDossierPrompt", () => {
  it("lists ledger sources by refId so the writer can cite them", () => {
    const p = buildDossierPrompt(dossier, ledger);
    expect(p).toContain("ref-1");
    expect(p).toContain("Probe opened");
    expect(p).toContain("Probe vs shorts");
  });
});

describe("assembleTakeBody", () => {
  it("joins the four sections with blank lines", () => {
    const body = assembleTakeBody({ background: "a", recent_events: "b", the_data: "c", outlook: "d" });
    expect(body).toBe("a\n\nb\n\nc\n\nd");
  });
});

describe("assembleDeepDiveBody", () => {
  it("renders ## headings for each titled section", () => {
    const body = assembleDeepDiveBody([
      { heading: "The probe timeline", prose: "para one" },
      { heading: "What the shorts saw", prose: "para two" },
    ]);
    expect(body).toContain("## The probe timeline\n\npara one");
    expect(body).toContain("## What the shorts saw\n\npara two");
  });
});

describe("synthesiseFromDossier (grounding + parse retry)", () => {
  it("drops invented citations and keeps only ledger-backed ones", async () => {
    const l = new CitationLedger();
    const ref = l.register({ type: "news", url: "https://x/1", source: "S", headline: "Probe", date: "2026-05-01" });
    const d: Dossier = { stockCode: "DRO", tier: "take", angle: "a", summary: "s", threads: [], keyNumbers: [] };
    const deps: DossierWriterDeps = {
      generate: async () => JSON.stringify({
        headline: "Shorts held through the probe", sentiment: "negative",
        background: `Probe opened [${ref}].`, recent_events: `Then nothing [ref-9].`,
        the_data: "14% short.", outlook: "Still climbing.",
      }),
      slug: async () => "dro-shorts-held",
    };
    const out = await synthesiseFromDossier(d, l, "DRO", deps);
    expect(out.citations.map((c) => c.refId)).toEqual(["ref-1"]);   // only the real one survives
    expect(out.droppedCitations).toContain("ref-9");                 // invented one dropped
    expect(out.bodyMd).not.toContain("ref-9");
    expect(out.slug).toBe("dro-shorts-held");
    expect(out.tier).toBe("take");
  });

  it("retries once on unparseable JSON, then succeeds", async () => {
    const l = new CitationLedger();
    const d: Dossier = { stockCode: "DRO", tier: "take", angle: "a", summary: "s", threads: [], keyNumbers: [] };
    let calls = 0;
    const deps: DossierWriterDeps = {
      generate: async () => {
        calls++;
        if (calls === 1) return "{not json";
        return JSON.stringify({ headline: "h", sentiment: "neutral", background: "b", recent_events: "r", the_data: "d", outlook: "o" });
      },
      slug: async () => "dro-h",
    };
    const out = await synthesiseFromDossier(d, l, "DRO", deps);
    expect(calls).toBe(2);
    expect(out.headline).toBe("h");
  });

  it("throws if JSON is unparseable on both attempts", async () => {
    const l = new CitationLedger();
    const d: Dossier = { stockCode: "DRO", tier: "take", angle: "a", summary: "s", threads: [], keyNumbers: [] };
    const deps: DossierWriterDeps = { generate: async () => "garbage", slug: async () => "x" };
    await expect(synthesiseFromDossier(d, l, "DRO", deps)).rejects.toThrow(/unparseable/);
  });
});
