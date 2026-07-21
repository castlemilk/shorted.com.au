import {
  HAS_DIESEL,
  HAS_LABOUR,
  hasDiesel,
  hasLabour,
  unavailableFor,
} from "../availability";

describe("economy availability helpers", () => {
  it("HAS_LABOUR excludes the territories ABS doesn't seas-adj (NT, ACT)", () => {
    expect(HAS_LABOUR).toEqual(["nsw", "vic", "qld", "sa", "wa", "tas"]);
    expect(hasLabour("wa")).toBe(true);
    expect(hasLabour("nt")).toBe(false);
    expect(hasLabour("act")).toBe(false);
  });

  it("HAS_DIESEL excludes ACT (folded into NSW by DCCEEW)", () => {
    expect(HAS_DIESEL).not.toContain("act");
    expect(HAS_DIESEL).toContain("nsw");
    expect(hasDiesel("act")).toBe(false);
    expect(hasDiesel("nsw")).toBe(true);
  });

  it("unavailableFor mirrors the registry unavailableStates", () => {
    expect(unavailableFor("unemployment")).toEqual(["nt", "act"]);
    expect(unavailableFor("diesel_sales")).toEqual(["act"]);
  });
});
