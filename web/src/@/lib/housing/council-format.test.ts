import { councilHref, crossBorderJurisdiction, fmtCouncilShare, fmtDensity } from "./council";
import { councilKeyFacts, fmtShare } from "./council-page";
import { COUNCIL_METRICS } from "./council-metrics";
import type { CouncilSummary } from "~/gen/shorts/v1alpha1/housing_pb";

describe("fmtDensity", () => {
  it("never shows a bare 0 for a council people live in", () => {
    // Unincorporated NSW: 975 residents over 93,209 km².
    expect(fmtDensity(975 / 93_209)).toBe("<0.1");
    expect(fmtDensity(0.4)).toBe("0.4");
    expect(fmtDensity(3.24)).toBe("3.2");
  });

  it("keeps whole numbers from 10 up", () => {
    expect(fmtDensity(9.96)).toBe("10");
    expect(fmtDensity(3536.2)).toBe("3,536");
  });

  it("formats a true zero as 0 (a legend tick, never a council)", () => {
    expect(fmtDensity(0)).toBe("0");
  });

  it("is what the hub tile and the map tooltip show", () => {
    const facts = councilKeyFacts({
      population: 975, erpYear: 2025, densityPerSqkm: 0.0105, areaSqkm: 93_209,
    } as CouncilSummary);
    expect(facts.find((f) => f.label === "Density")?.value).toBe("<0.1/km²");
    const density = COUNCIL_METRICS.find((m) => m.key === "density")!;
    expect(density.format(0.0105)).toBe("<0.1/km²");
  });
});

describe("member share", () => {
  // The suburb card and the council hub read the same share; they must round
  // it the same way, once. Kingsgrove is 0.4946 of its residents.
  it("reads the same on the hub and the suburb card", () => {
    expect(fmtShare(0.4946)).toBe("49%");
    expect(fmtCouncilShare(0.4946)).toBe("49%");
    expect(fmtShare).toBe(fmtCouncilShare);
  });
});

describe("cross-border neighbour chip", () => {
  it("reads a state or territory by its code", () => {
    expect(crossBorderJurisdiction("VIC")).toBe("VIC");
    expect(crossBorderJurisdiction("ACT")).toBe("ACT");
  });

  // Shoalhaven <-> 99399 (Unincorp. Other Territories): the only land border
  // is Jervis Bay. A bare "OT" told the reader nothing.
  it("names Jervis Bay instead of the Other Territories code", () => {
    expect(crossBorderJurisdiction("OT")).toBe("Jervis Bay Territory");
    expect(councilHref("OT", "unincorp-other-territories", true)).toBeNull();
  });
});
