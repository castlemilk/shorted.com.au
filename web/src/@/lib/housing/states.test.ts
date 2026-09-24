import { suburbHref, suburbSlug, titleCaseName } from "./states";

describe("titleCaseName", () => {
  it.each([
    ["MCMAHONS POINT", "Mcmahons Point"],
    ["O'CONNOR", "O'Connor"],
    ["ST KILDA EAST", "St Kilda East"],
    ["PRESTON (VIC.)", "Preston (Vic.)"],
    ["ACT REMAINDER - BELCONNEN", "Act Remainder - Belconnen"],
  ])("%s → %s", (input, expected) => {
    expect(titleCaseName(input)).toBe(expected);
  });
});

describe("suburb URLs", () => {
  it("slugifies the ABS name and appends a postcode only when one exists", () => {
    expect(suburbSlug("PRESTON (VIC.)", "")).toBe("preston-vic");
    expect(suburbSlug("Bondi Beach", "2026")).toBe("bondi-beach-2026");
  });

  it("links to the clean canonical path with no query string", () => {
    // The page resolves the suburb from the path, and the canonical it
    // advertises has no ?sal=. Carrying the SAL code on every internal link
    // made each suburb a second, parameterised URL for crawlers to fetch and
    // fold — measured in Search Console as ?sal= variants earning impressions.
    expect(suburbHref("VIC", { salName: "PRESTON (VIC.)", postcode: "", salCode: "22121" })).toBe(
      "/housing/vic/preston-vic",
    );
  });
});
