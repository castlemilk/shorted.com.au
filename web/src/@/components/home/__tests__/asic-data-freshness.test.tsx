import { render } from "@testing-library/react";
import {
  AsicDataFreshness,
  latestAsicDataDate,
} from "../asic-data-freshness";

describe("latestAsicDataDate", () => {
  it("returns null when there is no data", () => {
    expect(latestAsicDataDate(undefined)).toBeNull();
    expect(latestAsicDataDate([])).toBeNull();
    expect(latestAsicDataDate([{ points: [] }])).toBeNull();
  });

  it("reads protobuf Timestamp seconds (connect transport)", () => {
    const date = latestAsicDataDate([
      {
        points: [
          { timestamp: { seconds: BigInt(1_752_000_000) } },
          { timestamp: { seconds: BigInt(1_753_000_000) } },
        ],
      },
    ]);
    expect(date?.toISOString()).toBe(
      new Date(1_753_000_000 * 1000).toISOString(),
    );
  });

  it("reads RFC3339 strings (edge-read transport)", () => {
    const date = latestAsicDataDate([
      { points: [{ timestamp: "2026-07-20T00:00:00Z" }] },
      { points: [{ timestamp: "2026-07-23T00:00:00Z" }] },
    ]);
    expect(date?.toISOString()).toBe("2026-07-23T00:00:00.000Z");
  });

  it("ignores unusable timestamps", () => {
    expect(
      latestAsicDataDate([
        { points: [{ timestamp: "not-a-date" }, { timestamp: null }] },
      ]),
    ).toBeNull();
  });
});

describe("AsicDataFreshness", () => {
  it("renders nothing without a date", () => {
    const { container } = render(<AsicDataFreshness date={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders the as-at line with a machine-readable date", () => {
    const { container } = render(
      <AsicDataFreshness date={new Date("2026-07-23T02:00:00Z")} />,
    );
    expect(container.textContent).toContain("ASIC short position data as at");
    expect(container.textContent).toContain("(T+4 reporting delay)");
    expect(container.querySelector("time")?.getAttribute("dateTime")).toBe(
      "2026-07-23",
    );
  });
});
