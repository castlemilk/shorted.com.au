import {
  formatHousingValue,
  toSeriesPoints,
  transformSeries,
} from "./series-data";

const utcSeconds = (iso: string) => BigInt(Date.parse(iso) / 1000);

describe("toSeriesPoints", () => {
  it("converts protobuf-like timestamp seconds into chart points", () => {
    expect(
      toSeriesPoints([
        {
          period: { seconds: utcSeconds("2024-03-01T00:00:00.000Z") },
          value: 123.45,
        },
      ]),
    ).toEqual([{ date: new Date("2024-03-01T00:00:00.000Z"), value: 123.45 }]);
  });

  it("drops points with missing or invalid dates", () => {
    expect(
      toSeriesPoints([
        { value: 1 },
        { period: { seconds: Number.POSITIVE_INFINITY }, value: 2 },
        { period: { seconds: utcSeconds("2024-06-01T00:00:00.000Z") }, value: 3 },
      ]),
    ).toEqual([{ date: new Date("2024-06-01T00:00:00.000Z"), value: 3 }]);
  });
});

describe("transformSeries", () => {
  const points = [
    { date: new Date("2023-01-15T00:00:00.000Z"), value: 100 },
    { date: new Date("2023-02-01T00:00:00.000Z"), value: 0 },
    { date: new Date("2024-01-31T00:00:00.000Z"), value: 125 },
    { date: new Date("2024-02-29T00:00:00.000Z"), value: 10 },
    { date: new Date("2024-03-01T00:00:00.000Z"), value: 130 },
  ];

  it("preserves points for the level transform", () => {
    expect(transformSeries(points, "level")).toBe(points);
  });

  it("calculates annual percentage change from the same UTC month", () => {
    expect(transformSeries(points, "yoy")).toEqual([
      { date: new Date("2024-01-31T00:00:00.000Z"), value: 25 },
    ]);
  });

  it("skips annual changes with a missing prior month or zero base", () => {
    expect(transformSeries(points, "yoy").map((point) => point.date.toISOString())).toEqual([
      "2024-01-31T00:00:00.000Z",
    ]);
  });
});

describe("formatHousingValue", () => {
  it("formats percentage and index values", () => {
    expect(formatHousingValue(4.35, "percent")).toBe("4.35%");
    expect(formatHousingValue(6.2, "percent")).toBe("6.2%");
    expect(formatHousingValue(4, "percent")).toBe("4%");
    expect(formatHousingValue(101.6, "index")).toBe("102");
  });

  it("preserves dwelling-price AUD formatting", () => {
    expect(formatHousingValue(1_875_432, "aud")).toBe("$1.88M");
    expect(formatHousingValue(58_650, "aud")).toBe("$59k");
    expect(formatHousingValue(950, "aud")).toBe("$950");
  });

  it("uses compact billions and trillions for RBA E1 values", () => {
    expect(formatHousingValue(1_250_000_000, "aud")).toBe("$1.25B");
    expect(formatHousingValue(12_000_000_000_000, "aud")).toBe("$12.00T");
  });
});
