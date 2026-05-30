import { describe, it, expect } from "vitest";
import { CitationLedger, compactCitations } from "./ledger.js";

const src = (over: Partial<import("./ledger.js").LedgerSource> = {}) => ({
  type: "news" as const,
  url: "https://ex.com/a",
  source: "Stockhead",
  headline: "A headline",
  date: "2026-05-01",
  ...over,
});

describe("CitationLedger", () => {
  it("assigns sequential refIds in registration order", () => {
    const l = new CitationLedger();
    expect(l.register(src({ url: "https://ex.com/a" }))).toBe("ref-1");
    expect(l.register(src({ url: "https://ex.com/b" }))).toBe("ref-2");
  });

  it("dedupes by type+url, returning the existing refId", () => {
    const l = new CitationLedger();
    const first = l.register(src({ url: "https://ex.com/a" }));
    const again = l.register(src({ url: "https://ex.com/a", headline: "changed" }));
    expect(again).toBe(first);
    expect(l.size()).toBe(1);
  });

  it("knows whether a refId is in the ledger", () => {
    const l = new CitationLedger();
    l.register(src());
    expect(l.has("ref-1")).toBe(true);
    expect(l.has("ref-9")).toBe(false);
  });
});

describe("compactCitations", () => {
  it("drops markers not in the ledger and renumbers cited ones in first-appearance order", () => {
    const l = new CitationLedger();
    l.register(src({ url: "https://ex.com/a", type: "news" }));     // ref-1
    l.register(src({ url: "https://ex.com/b", type: "report" }));   // ref-2
    l.register(src({ url: "https://ex.com/c", type: "news" }));     // ref-3
    // Body cites ref-3 then ref-1, and a bogus ref-8 that must be dropped.
    const body = "First [ref-3]. Then [ref-1]. Bogus [ref-8].";
    const { body: out, citations } = compactCitations(body, l);
    expect(out).toBe("First [ref-1]. Then [ref-2]. Bogus .");
    expect(citations.map((c) => c.refId)).toEqual(["ref-1", "ref-2"]);
    expect(citations[0]!.url).toBe("https://ex.com/c");
    expect(citations[1]!.url).toBe("https://ex.com/a");
    expect(citations[1]!.type).toBe("news");
  });

  it("reports dangling markers it dropped", () => {
    const l = new CitationLedger();
    l.register(src());
    const { dropped } = compactCitations("ok [ref-1] bad [ref-7]", l);
    expect(dropped).toEqual(["ref-7"]);
  });
});
