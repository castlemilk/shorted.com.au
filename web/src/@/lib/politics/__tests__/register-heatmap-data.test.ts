import { registerHeatmapProps } from "../register-heatmap-data";

// What the analytics rpc returns, with a field the island never reads standing
// in for the generated message's own.
const analytics = {
  cells: [
    { partyAb: "ALP", industry: "Banks", people: 12, companies: 4, $typeName: "cell" },
    { partyAb: "ALP", industry: "Not Applic", people: 30, companies: 9, $typeName: "cell" },
    { partyAb: "LIB", industry: "CLASS PEND", people: 2, companies: 1, $typeName: "cell" },
    { partyAb: "LIB", industry: "Materials", people: 7, companies: 5, $typeName: "cell" },
  ],
  industries: [
    { industry: "Banks", people: 20, companies: 4, $typeName: "axis" },
    { industry: "Not Applic", people: 41, companies: 12, $typeName: "axis" },
    { industry: "Materials", people: 9, companies: 5, $typeName: "axis" },
  ],
  parties: [
    { partyAb: "ALP", people: 50, $typeName: "party" },
    { partyAb: "LIB", people: 40, $typeName: "party" },
  ],
  industriesOmitted: 3,
};

describe("registerHeatmapProps", () => {
  it("sends the browser no placeholder industry: no cell and no row", () => {
    const props = registerHeatmapProps(analytics);
    expect(props.cells.map((c) => c.industry)).toEqual(["Banks", "Materials"]);
    expect(props.industries.map((i) => i.industry)).toEqual(["Banks", "Materials"]);
  });

  it("hands the island plain objects with only the fields it reads", () => {
    const props = registerHeatmapProps(analytics);
    expect(props).toEqual({
      cells: [
        { partyAb: "ALP", industry: "Banks", people: 12, companies: 4 },
        { partyAb: "LIB", industry: "Materials", people: 7, companies: 5 },
      ],
      industries: [
        { industry: "Banks", people: 20, companies: 4 },
        { industry: "Materials", people: 9, companies: 5 },
      ],
      parties: [
        { partyAb: "ALP", people: 50 },
        { partyAb: "LIB", people: 40 },
      ],
      industriesOmitted: 3,
    });
  });

  it("is empty when the analytics read failed", () => {
    expect(registerHeatmapProps(undefined)).toEqual({
      cells: [],
      industries: [],
      parties: [],
      industriesOmitted: 0,
    });
  });
});
