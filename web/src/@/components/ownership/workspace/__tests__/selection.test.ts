/// <reference types="jest" />

import {
  cleanSelection,
  isFundKey,
  parseSelection,
  selectionHeading,
  serializeSelection,
  withoutSelection,
  type Selection,
} from "../selection";

describe("selection codec (spec 14.1)", () => {
  const cases: Array<[string, Selection]> = [
    ["stock:PLS", { kind: "stock", code: "PLS" }],
    ["holder:vanguard", { kind: "holder", key: "vanguard" }],
    ["holder:name:Jane Smith", { kind: "holder", key: "name:Jane Smith" }],
    [
      "connection:index_manager>Materials",
      { kind: "connection", holderKind: "index_manager", sector: "Materials" },
    ],
    [
      "connection:bank_broker>Health Care Equipment & Services",
      { kind: "connection", holderKind: "bank_broker", sector: "Health Care Equipment & Services" },
    ],
    ["cell:Materials@2026-10-26", { kind: "cell", sector: "Materials", date: "2026-10-26" }],
    [
      "cell:Materials@2026-10-26:index_manager",
      { kind: "cell", sector: "Materials", date: "2026-10-26", holderKind: "index_manager" },
    ],
    [
      "cell:Health Care Equipment & Services@2026-10-26:bank_broker",
      { kind: "cell", sector: "Health Care Equipment & Services", date: "2026-10-26", holderKind: "bank_broker" },
    ],
    ["fund:asx:A200", { kind: "fund", fundKey: "asx:A200" }],
    ["fund:abn:12345678901", { kind: "fund", fundKey: "abn:12345678901" }],
    ["fund:aware/High Growth", { kind: "fund", fundKey: "aware/High Growth" }],
    ["fund:aware/Growth/Fund", { kind: "fund", fundKey: "aware/Growth/Fund" }],
    ["holding:asx:A200/BHP", { kind: "holding", fundKey: "asx:A200", code: "BHP" }],
    ["holding:abn:12345678901/CBA", { kind: "holding", fundKey: "abn:12345678901", code: "CBA" }],
    ["holding:aware/High Growth/BHP", { kind: "holding", fundKey: "aware/High Growth", code: "BHP" }],
  ];

  it.each(cases)("parses %s and serialises it back to the same string", (raw, expected) => {
    expect(parseSelection(raw)).toEqual(expected);
    expect(serializeSelection(expected)).toBe(raw);
  });

  it.each([
    "",
    "stock",
    "stock:",
    "stock:pls",
    "stock:TOOLONGCODE",
    "planet:MARS",
    "connection:index_manager",
    "connection:Index Manager>Materials",
    "connection:index_manager> Materials",
    "cell:Materials@2026-02-30",
    "cell:Materials@yesterday",
    "cell:@2026-10-26",
    "cell:Materials@2026-10-26:",
    "cell:Materials@2026-10-26:Index Manager",
    "cell:Materials@2026-10-26:index_manager:extra",
    "cell:Materials@2026-10-26:Index_manager",
    "cell:Materials@2026-02-30:index_manager",
    "holding:A200BHP",
    "holding:A200/bhp",
    "fund:has space",
    "fund:A200",
    "fund:asx:a200",
    "fund:asx:A",
    "fund:asx:ABCDEFGHIJK",
    "fund:abn:1234567890",
    "fund:Aware/High Growth",
    "fund:aware/",
    "fund:/High Growth",
    "fund:aware/ High Growth",
    "fund:aware/High Growth ",
    "fund:aware/Bad\u0001Name",
    "holding:A200/BHP",
    "holding:asx:A200/bhp",
    "holding:aware/High Growth",
    "holding:asx:A200/",
    "holder:bad\nkey",
    "holder:" + "x".repeat(121),
  ])("refuses %j rather than reading a partial selection", (raw) => {
    expect(parseSelection(raw)).toBeNull();
    expect(cleanSelection(raw)).toBe("");
  });

  it("refuses a fund name over 200 characters through parseSelection (the link cap is 280, so the name rule is reached)", () => {
    // "fund:aware/" plus 201 characters is 212 long: under the link cap, so FUND_NAME_MAX is what refuses it.
    const link = "fund:aware/" + "x".repeat(201);
    expect(link.length).toBeLessThan(280);
    expect(isFundKey("aware/" + "x".repeat(200))).toBe(true);
    expect(isFundKey("aware/" + "x".repeat(201))).toBe(false);
    expect(parseSelection(link)).toBeNull();
  });

  it("reads a selection link of 280 characters and refuses one of 281", () => {
    // The longest link a fund key can make: a 64-character slug and a 200-character name (FUND_NAME_MAX).
    const link = `holding:${"a".repeat(64)}/${"x".repeat(200)}/ABCDEF`;
    expect(link).toHaveLength(280);
    expect(cleanSelection(link)).toBe(link);
    const over = `holding:${"a".repeat(64)}/${"x".repeat(200)}/ABCDEFG`;
    expect(over).toHaveLength(281);
    expect(cleanSelection(over)).toBe("");
  });

  it("reads the longest holding a fund key can make: a 64-character slug and a 200-character name", () => {
    const slug = "a".repeat(64);
    const link = `holding:${slug}/${"x".repeat(200)}/ABCDEF`;
    expect(link.length).toBeLessThanOrEqual(280);
    expect(cleanSelection(link)).toBe(link);
  });

  it("writes a cell's holder kind after the week, and no colon for all holder types", () => {
    expect(serializeSelection({ kind: "cell", sector: "Materials", date: "2026-10-26" })).toBe("cell:Materials@2026-10-26");
    expect(
      serializeSelection({ kind: "cell", sector: "Materials", date: "2026-10-26", holderKind: "index_manager" }),
    ).toBe("cell:Materials@2026-10-26:index_manager");
    expect(cleanSelection("cell:Materials@2026-10-26:")).toBe("");
  });

  it("refuses a non-string in cleanSelection", () => {
    expect(cleanSelection(42)).toBe("");
    expect(cleanSelection(undefined)).toBe("");
  });

  it("names the kind of selection in the inspector's heading", () => {
    expect(selectionHeading({ kind: "stock", code: "BHP" })).toBe("Selected company");
    expect(selectionHeading({ kind: "holding", fundKey: "A200", code: "BHP" })).toBe("Selected holding");
  });

  it("drops the selection from a query string and keeps every other parameter", () => {
    expect(withoutSelection("sel=stock%3ABHP&window=28")).toBe("window=28");
    expect(withoutSelection("sel=stock%3ABHP")).toBe("");
    expect(withoutSelection("")).toBe("");
  });
});
