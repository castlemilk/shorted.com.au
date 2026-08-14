import { yDomainsFor } from "../dual-axis-chart";

describe("DualAxisChart shared scale", () => {
  it("uses one domain that covers both series' extents", () => {
    const primary = [
      { date: new Date("2024-01-01"), value: 100 },
      { date: new Date("2024-02-01"), value: 200 },
    ];
    const secondary = [
      { date: new Date("2024-01-01"), value: -500 },
      { date: new Date("2024-02-01"), value: 1_000 },
    ];

    const domains = yDomainsFor(primary, secondary, true);

    expect(domains.primary).toEqual(domains.secondary);
    expect(domains.primary[0]).toBeLessThanOrEqual(-500);
    expect(domains.primary[1]).toBeGreaterThanOrEqual(1_000);
  });
});
