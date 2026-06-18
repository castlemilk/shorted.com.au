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

  it("fails closed when a literal escape sequence is glued to a component", async () => {
    // body contains literal backslash-n (not a real newline) before <StatGroup>
    const r = await validateMdx(
      'Sector average 6.82%.\\n\\n<StatGroup><Stat label="Short %" value="12.4%" cite="ref-2" /></StatGroup>',
      OPTS,
    );
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes("not normalised"))).toBe(true);
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

  it("accepts BankShortBasket with a known basket or no banks prop", async () => {
    const r = await validateMdx(`<BankShortBasket banks="BHP,ZIP" window="1y" mode="dollar" />`, OPTS);
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
    const r2 = await validateMdx(`<BankShortBasket />`, OPTS);
    expect(r2.ok).toBe(true);
  });

  it("rejects BankShortBasket with an unknown code, window, or mode", async () => {
    const bad = await validateMdx(`<BankShortBasket banks="BHP,XYZ" />`, OPTS);
    expect(bad.ok).toBe(false);
    expect(bad.errors.some((e) => e.includes('"XYZ"'))).toBe(true);
    const badWin = await validateMdx(`<BankShortBasket banks="BHP" window="2y" />`, OPTS);
    expect(badWin.ok).toBe(false);
    const badMode = await validateMdx(`<BankShortBasket banks="BHP" mode="sideways" />`, OPTS);
    expect(badMode.ok).toBe(false);
  });

  it("accepts ShortBasket with a sector key or none, rejects bad keys", async () => {
    const ok = await validateMdx(`<ShortBasket basket="lithium" window="1y" mode="dollar" />`, OPTS);
    expect(ok.ok).toBe(true);
    const ok2 = await validateMdx(`<ShortBasket />`, OPTS);
    expect(ok2.ok).toBe(true);
    const bad = await validateMdx(`<ShortBasket basket="Lithium" />`, OPTS); // uppercase
    expect(bad.ok).toBe(false);
    const badWin = await validateMdx(`<ShortBasket basket="lithium" window="5y" />`, OPTS);
    expect(badWin.ok).toBe(false);
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

  it("strips BankShortBasket and ShortBasket cleanly", () => {
    const out = stripMdxComponents(`before\n\n<BankShortBasket banks="CBA,WBC,NAB,ANZ" window="1y" mode="dollar" />\n\n<ShortBasket basket="lithium" />\n\nafter`);
    expect(out).not.toContain("<BankShortBasket");
    expect(out).not.toContain("<ShortBasket");
    expect(out).toContain("before");
    expect(out).toContain("after");
  });
});
