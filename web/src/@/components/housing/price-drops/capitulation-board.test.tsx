import { render, screen } from "@testing-library/react";
import { CapitulationBoard } from "./capitulation-board";

const pts = () => [
  { snapshotDate: "2026-08-03", dropRate: 0.10, medianDropPct: 0.05, panelSuburbs: 491, coverageRatio: 1, isGap: false, activeAddresses: 0, droppedAddresses: 0, withdrawnThenRelisted: 120, delistedCount: 45 },
  { snapshotDate: "2026-08-14", dropRate: 0, medianDropPct: 0, panelSuburbs: 491, coverageRatio: 0.1, isGap: true, activeAddresses: 0, droppedAddresses: 0, withdrawnThenRelisted: 0, delistedCount: 0 },
  { snapshotDate: "2026-08-16", dropRate: 0.12, medianDropPct: 0.05, panelSuburbs: 499, coverageRatio: 1, isGap: false, activeAddresses: 0, droppedAddresses: 0, withdrawnThenRelisted: 314, delistedCount: 128 },
];

test("renders the latest non-gap point's capitulation counters", () => {
  render(<CapitulationBoard points={pts()} />);
  expect(screen.getByText("314")).toBeInTheDocument();
  expect(screen.getByText("128")).toBeInTheDocument();
});

test("renders nothing when every point is a gap", () => {
  const allGaps = pts().map((p) => ({ ...p, isGap: true }));
  const { container } = render(<CapitulationBoard points={allGaps} />);
  expect(container).toBeEmptyDOMElement();
});

test("dates the reading and says when it is older than the series", () => {
  const trailingGaps = [...pts(), { ...pts()[1]!, snapshotDate: "2026-08-20" }];
  render(<CapitulationBoard points={trailingGaps} />);
  expect(screen.getByTestId("capitulation-reading-date")).toHaveTextContent("Last reliable reading 16 Aug");
});

// The delist path marks sold and withdrawn listings alike (measured: at least
// 8.4% of delisted addresses had a sold card), so the label cannot say
// "withdrawn".
test("labels delistings as leaving the market, not as withdrawals", () => {
  render(<CapitulationBoard points={pts()} />);
  expect(screen.getByText("Left the market (30d)")).toBeInTheDocument();
  expect(screen.queryByText("Withdrawn (30d)")).not.toBeInTheDocument();
  expect(screen.getByText(/whether sold or withdrawn/)).toBeInTheDocument();
});

test("says when the counters' data ends before the reading's date", () => {
  render(<CapitulationBoard points={pts()} dataThroughIso="2026-08-15T03:00:00.000Z" />);
  expect(screen.getByTestId("capitulation-reading-date")).toHaveTextContent(
    /Reading for 16 Aug — the listing data behind it runs only to 15 Aug/,
  );
});
