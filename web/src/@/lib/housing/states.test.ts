import { splitSalName, suburbExplorerHref, suburbHref, suburbSlug, titleCaseName } from "./states";

describe("suburb names", () => {
  test("ABS names are never re-cased", () => {
    // Lowercase-then-capitalise is what published "Mccrae" and "Paddington (qld)".
    expect(titleCaseName("McCrae")).toBe("McCrae");
    expect(titleCaseName("Paddington (Qld)")).toBe("Paddington (Qld)");
    expect(titleCaseName("Carramar (WA)")).toBe("Carramar (WA)");
  });

  test("UPPERCASE sources are still title-cased", () => {
    expect(titleCaseName("ST KILDA EAST")).toBe("St Kilda East");
    expect(titleCaseName("O'CONNOR")).toBe("O'Connor");
    expect(titleCaseName("SMITH-JONES")).toBe("Smith-Jones");
  });

  // Federal members arrive as "Given SURNAME": the shouted word is fixed, the
  // proper-cased ones are left alone.
  test.each([
    ["Fiona PHILLIPS", "Fiona Phillips"],
    ["Clare O'NEIL", "Clare O'Neil"],
    ["Emma McBRIDE", "Emma McBride"],
    ["Michael McCORMACK", "Michael McCormack"],
    ["Alice JORDAN-BAIRD", "Alice Jordan-Baird"],
    ["Julie-Ann CAMPBELL", "Julie-Ann Campbell"],
    ["Luke John GOSLING", "Luke John Gosling"],
    ["Gabrielle de Vietri", "Gabrielle de Vietri"],
    ["Hon Michael O'Brien", "Hon Michael O'Brien"],
  ])("member %s → %s", (raw, shown) => {
    expect(titleCaseName(raw)).toBe(shown);
  });

  test("the qualifier splits off, keeping only its LGA part as a region", () => {
    expect(splitSalName("Paddington (Qld)")).toEqual({ place: "Paddington", region: null });
    expect(splitSalName("Richmond (Vic.)")).toEqual({ place: "Richmond", region: null });
    expect(splitSalName("Glenroy (Albury - NSW)")).toEqual({ place: "Glenroy", region: "Albury" });
    expect(splitSalName("Stony Creek (Central Goldfields - Vic.)")).toEqual({ place: "Stony Creek", region: "Central Goldfields" });
    expect(splitSalName("McCrae")).toEqual({ place: "McCrae", region: null });
    expect(splitSalName("ACT Remainder - Booth")).toEqual({ place: "ACT Remainder - Booth", region: null });
  });
});

// Every indexed suburb URL is minted from the raw salName, so the name fix must
// not move one of them. These are the slugs the site already serves.
describe("suburb slugs are unchanged by the name fix", () => {
  test.each([
    ["Bondi", "", "bondi"],
    ["Paddington (Qld)", "", "paddington-qld"],
    ["Carramar (WA)", "", "carramar-wa"],
    ["Richmond (Vic.)", "", "richmond-vic"],
    ["Glenroy (Albury - NSW)", "", "glenroy-albury-nsw"],
    ["McCrae", "", "mccrae"],
    ["McMahons Point", "", "mcmahons-point"],
    ["O'Connor (ACT)", "", "o-connor-act"],
    ["St Kilda East", "3183", "st-kilda-east-3183"],
  ])("%s → %s", (name, postcode, slug) => {
    expect(suburbSlug(name, postcode)).toBe(slug);
  });

});

// Internal links must be the URL the sitemap lists and the page canonicalises
// to. The page resolves the suburb from the path alone, so `?sal=` only minted a
// duplicate URL (111 such links on the pages probed 2026-10-21), and no SAL row
// carries a postcode (0 of 15,345 in prod), so a postcode slug only redirected.
describe("suburbHref is the canonical path", () => {
  test.each([
    ["VIC", "Altona North", "/housing/vic/altona-north"],
    ["QLD", "Paddington (Qld)", "/housing/qld/paddington-qld"],
    // A name that repeats inside one state: ABS qualifies each with its LGA,
    // and that qualifier is what keeps the two slugs apart.
    ["VIC", "Ascot (Ballarat - Vic.)", "/housing/vic/ascot-ballarat-vic"],
    ["VIC", "Ascot (Greater Bendigo - Vic.)", "/housing/vic/ascot-greater-bendigo-vic"],
    ["ACT", "O'Connor (ACT)", "/housing/act/o-connor-act"],
  ])("%s %s → %s", (state, salName, href) => {
    const got = suburbHref(state, { salName, postcode: "" });
    expect(got).toBe(href);
    expect(got).not.toContain("?");
    expect(got).not.toMatch(/-\d{4}$/);
  });

  test("a feed postcode stays in the slug, exactly as the sitemap mints it", () => {
    expect(suburbHref("VIC", { salName: "St Kilda East", postcode: "3183" }))
      .toBe(`/housing/vic/${suburbSlug("St Kilda East", "3183")}`);
  });

  test("the explorer deep link is the only href that carries ?sal=", () => {
    expect(suburbExplorerHref("QLD", "32250")).toBe("/housing/qld?sal=32250");
    expect(suburbExplorerHref("NSW", "12345", "zoning")).toBe("/housing/nsw?sal=12345&overlays=zoning");
  });
});
