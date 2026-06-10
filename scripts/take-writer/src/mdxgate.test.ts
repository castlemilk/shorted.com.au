import { describe, it, expect } from "vitest";
import { validateMdx, stripMdxComponents } from "./mdxgate.js";

const LEDGER_REFS = new Set(["ref-1", "ref-2"]);
const KNOWN_CODES = new Set(["BHP", "ZIP"]);
const OPTS = { ledgerRefs: LEDGER_REFS, knownCodes: KNOWN_CODES };

describe("validateMdx", () => {
  it("passes a valid article", async () => {
    const r = await validateMdx(
      `Para one [ref-1].\n\n<ShortInterestChart code="BHP" window="6m" />\n\n<StatGroup><Stat label="Short interest" value="12.4%" cite="ref-2" /></StatGroup>`,
      OPTS,
    );
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.componentCount).toBeGreaterThanOrEqual(3);
  });

  it("rejects unknown components and script tags", async () => {
    const r = await validateMdx(`<Marquee />`, OPTS);
    expect(r.ok).toBe(false);
    const r2 = await validateMdx(`<script>alert(1)</script>`, OPTS);
    expect(r2.ok).toBe(false);
  });

  it("rejects import/export statements", async () => {
    const r = await validateMdx(`import x from "evil";\n\nhello`, OPTS);
    expect(r.ok).toBe(false);
  });

  it("rejects a chart for an unknown stock code or bad window", async () => {
    const r = await validateMdx(`<ShortInterestChart code="XYZ" window="6m" />`, OPTS);
    expect(r.ok).toBe(false);
    const r2 = await validateMdx(`<ShortInterestChart code="BHP" window="7w" />`, OPTS);
    expect(r2.ok).toBe(false);
  });

  it("rejects a cite not present in the ledger", async () => {
    const r = await validateMdx(`<StatGroup><Stat label="x" value="1" cite="ref-9" /></StatGroup>`, OPTS);
    expect(r.ok).toBe(false);
  });

  it("rejects MDX that fails to compile", async () => {
    const r = await validateMdx(`<StatGroup>\n<Stat label="x" value="1"`, OPTS);
    expect(r.ok).toBe(false);
  });
});

describe("stripMdxComponents", () => {
  it("degrades to plain markdown", () => {
    const out = stripMdxComponents(`before\n\n<ShortInterestChart code="BHP" />\n\n<PullQuote>keep this text</PullQuote>\n\nafter`);
    expect(out).not.toContain("<ShortInterestChart");
    expect(out).toContain("> keep this text");
    expect(out).toContain("before");
    expect(out).toContain("after");
  });

  it("converts Stat and TimelineEvent to text", () => {
    const out = stripMdxComponents(`<StatGroup><Stat label="Short interest" value="12.4%" /></StatGroup>\n<Timeline><TimelineEvent date="2026-04-02" label="CEO sells" /></Timeline>`);
    expect(out).toContain("**Short interest: 12.4%**");
    expect(out).toContain("- 2026-04-02 — CEO sells");
    expect(out).not.toMatch(/<[A-Z]/);
  });

  it("handles props in any order", () => {
    const out = stripMdxComponents(`<Stat value="12.4%" label="Short interest" />\n<TimelineEvent label="CEO sells" date="2026-04-02" cite="ref-1" />`);
    expect(out).toContain("**Short interest: 12.4%**");
    expect(out).toContain("- 2026-04-02 — CEO sells");
  });
});
