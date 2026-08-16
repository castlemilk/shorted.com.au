import { render, screen } from "@testing-library/react";
import { CapitulationBoard } from "./capitulation-board";

const pts = () => [
  { snapshotDate: "2026-08-03", dropRate: 0.10, medianDropPct: 0.05, panelSuburbs: 491, coverageRatio: 1, isGap: false, activeAddresses: 0, droppedAddresses: 0, relistedLower: 120, delistedCount: 45 },
  { snapshotDate: "2026-08-14", dropRate: 0, medianDropPct: 0, panelSuburbs: 491, coverageRatio: 0.1, isGap: true, activeAddresses: 0, droppedAddresses: 0, relistedLower: 0, delistedCount: 0 },
  { snapshotDate: "2026-08-16", dropRate: 0.12, medianDropPct: 0.05, panelSuburbs: 499, coverageRatio: 1, isGap: false, activeAddresses: 0, droppedAddresses: 0, relistedLower: 314, delistedCount: 128 },
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
