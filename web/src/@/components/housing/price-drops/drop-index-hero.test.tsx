import { render, screen } from "@testing-library/react";
import { DropIndexHero } from "./drop-index-hero";

const pts = () => [
  { snapshotDate: "2026-08-03", dropRate: 0.10, medianDropPct: 0.05, panelSuburbs: 491, coverageRatio: 1, isGap: false, activeAddresses: 0, droppedAddresses: 0, withdrawnThenRelisted: 0, delistedCount: 0 },
  { snapshotDate: "2026-08-14", dropRate: 0, medianDropPct: 0, panelSuburbs: 491, coverageRatio: 0.1, isGap: true, activeAddresses: 0, droppedAddresses: 0, withdrawnThenRelisted: 0, delistedCount: 0 },
  { snapshotDate: "2026-08-16", dropRate: 0.12, medianDropPct: 0.05, panelSuburbs: 499, coverageRatio: 1, isGap: false, activeAddresses: 0, droppedAddresses: 0, withdrawnThenRelisted: 0, delistedCount: 0 },
];

// Builds n non-gap points, one per day starting at startDate, all at the same
// dropRate — used to exercise the MIN_POINTS_FOR_DIRECTION threshold without
// caring about the actual rate.
function longSeries(n: number, startDate = "2026-08-01") {
  const start = new Date(`${startDate}T00:00:00Z`);
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(start);
    d.setUTCDate(d.getUTCDate() + i);
    return {
      snapshotDate: d.toISOString().slice(0, 10),
      dropRate: 0.1,
      medianDropPct: 0.05,
      panelSuburbs: 499,
      coverageRatio: 1,
      isGap: false,
      activeAddresses: 0,
      droppedAddresses: 0,
      withdrawnThenRelisted: 0,
      delistedCount: 0,
    };
  });
}

test("captions the panel so the number is quotable", () => {
  render(<DropIndexHero points={pts()} trackingSince="2026-08-03" />);
  // Both the caption and (for a short series) the direction sentence contain
  // "tracking since 3 Aug", so match the caption specifically by its full text.
  expect(screen.getByText(/tracking since 3 Aug.*499 suburbs/i)).toBeInTheDocument();
});

// The 2026-08-13..15 crawl outage must not read as discounting collapsing to zero.
test("gap days are excluded from the rendered series", () => {
  render(<DropIndexHero points={pts()} trackingSince="2026-08-03" />);
  expect(screen.getByTestId("drop-index-plotted-count")).toHaveTextContent("2");
});

test("renders nothing rather than a misleading empty chart", () => {
  const { container } = render(<DropIndexHero points={[]} trackingSince="" />);
  expect(container).toBeEmptyDOMElement();
});

// Tracking only started 2026-08-13 — a short series (like the fixture above,
// with only 2 plotted points) cannot support a rising/falling/flat claim.
test("a short series does not claim a direction", () => {
  render(<DropIndexHero points={pts()} trackingSince="2026-08-03" />);
  expect(screen.getByText(/not enough history yet to call a direction/i)).toBeInTheDocument();
  expect(screen.queryByText(/^(up|down|flat) /i)).not.toBeInTheDocument();
});

// Once there are at least MIN_POINTS_FOR_DIRECTION (14) non-gap points, the
// component should call a real direction rather than hedging forever.
test("a long series calls a direction", () => {
  render(<DropIndexHero points={longSeries(14)} trackingSince="2026-08-01" />);
  expect(screen.queryByText(/not enough history yet to call a direction/i)).not.toBeInTheDocument();
  expect(screen.getByText(/flat since/i)).toBeInTheDocument();
});
