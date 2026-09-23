import { splitSalName, suburbHref, suburbSlug, titleCaseName } from "./states";

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

  test("the href keeps the load-bearing ?sal=", () => {
    expect(suburbHref("QLD", { salName: "Paddington (Qld)", postcode: "", salCode: "32250" }))
      .toBe("/housing/qld/paddington-qld?sal=32250");
  });
});
