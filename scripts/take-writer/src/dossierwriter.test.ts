import { describe, it, expect } from "vitest";
import { buildDossierPrompt, assembleTakeBody, assembleDeepDiveBody } from "./narrative.js";
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
