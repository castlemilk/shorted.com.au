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
    const out = await synthesiseFromDossier(d, l, "DRO", null, deps);
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
    const out = await synthesiseFromDossier(d, l, "DRO", null, deps);
    expect(calls).toBe(2);
    expect(out.headline).toBe("h");
  });

  it("throws if JSON is unparseable on both attempts", async () => {
    const l = new CitationLedger();
    const d: Dossier = { stockCode: "DRO", tier: "take", angle: "a", summary: "s", threads: [], keyNumbers: [] };
    const deps: DossierWriterDeps = { generate: async () => "garbage", slug: async () => "x" };
    await expect(synthesiseFromDossier(d, l, "DRO", null, deps)).rejects.toThrow(/unparseable/);
  });
});

describe("synthesiseFromDossier (MDX gate)", () => {
  const mkDossier = (code: string): Dossier =>
    ({ stockCode: code, tier: "take", angle: "a", summary: "s", threads: [], keyNumbers: [] });

  it("keeps valid MDX and passes the standfirst through (bodyFormat=mdx)", async () => {
    const l = new CitationLedger();
    const deps: DossierWriterDeps = {
      generate: async () => JSON.stringify({
        headline: "BHP shorts at 12.4%", standfirst: "Test standfirst.", sentiment: "neutral",
        background: "BHP short interest sits at 12.4%.",
        recent_events: "Nothing new this week.",
        the_data: `The data discussion.\n\n<ShortInterestChart code="BHP" window="6m" />\n\n<StatGroup><Stat label="Short %" value="12.4%" /></StatGroup>`,
        outlook: "Flat.",
      }),
      slug: async () => "bhp-shorts",
    };
    const out = await synthesiseFromDossier(mkDossier("BHP"), l, "BHP", null, deps);
    expect(out.bodyFormat).toBe("mdx");
    expect(out.standfirst).toBe("Test standfirst.");
    expect(out.bodyMd).toContain("<ShortInterestChart");
    expect(out.bodyMd).toContain("<StatGroup>");
  });

  it("strips to markdown when the body contains an unknown component", async () => {
    const l = new CitationLedger();
    const deps: DossierWriterDeps = {
      generate: async () => JSON.stringify({
        headline: "h", standfirst: "s", sentiment: "neutral",
        background: "b", recent_events: "r",
        the_data: `d\n\n<BadComponent />`, outlook: "o",
      }),
      slug: async () => "bhp-bad",
    };
    const out = await synthesiseFromDossier(mkDossier("BHP"), l, "BHP", null, deps);
    expect(out.bodyFormat).toBe("markdown");
    expect(out.bodyMd).not.toContain("<BadComponent");
  });

  it("marks a component-free body as plain markdown", async () => {
    const l = new CitationLedger();
    const deps: DossierWriterDeps = {
      generate: async () => JSON.stringify({
        headline: "h", standfirst: "s", sentiment: "neutral",
        background: "b", recent_events: "r", the_data: "d", outlook: "o",
      }),
      slug: async () => "bhp-plain",
    };
    const out = await synthesiseFromDossier(mkDossier("BHP"), l, "BHP", null, deps);
    expect(out.bodyFormat).toBe("markdown");
  });

  it("normalises literal \\n escape sequences so glued components still render as mdx", async () => {
    const l = new CitationLedger();
    // Reproduces the 4DX bug: the writer emitted literal backslash-n pairs
    // instead of real newlines, gluing the components to prose.
    const glued =
      "The data discussion." + "\\n\\n" +
      '<ShortInterestChart code="BHP" window="6m" />' + "\\n\\n" +
      '<StatGroup><Stat label="Short %" value="12.4%" /></StatGroup>';
    const deps: DossierWriterDeps = {
      generate: async () => JSON.stringify({
        headline: "BHP shorts at 12.4%", standfirst: "s", sentiment: "neutral",
        background: "b", recent_events: "r", the_data: glued, outlook: "o",
      }),
      slug: async () => "bhp-glued",
    };
    const out = await synthesiseFromDossier(mkDossier("BHP"), l, "BHP", null, deps);
    expect(out.bodyFormat).toBe("mdx");
    expect(out.bodyMd).not.toContain("\\n"); // no literal backslash-n survives
    expect(out.bodyMd).toContain("<ShortInterestChart");
    expect(out.bodyMd).toContain("<StatGroup>");
  });
});
