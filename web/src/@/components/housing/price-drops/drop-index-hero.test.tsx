import { render, screen } from "@testing-library/react";
import { DropIndexHero } from "./drop-index-hero";

const pts = () => [
  { snapshotDate: "2026-08-03", dropRate: 0.10, medianDropPct: 0.05, panelSuburbs: 491, coverageRatio: 1, isGap: false, activeAddresses: 0, droppedAddresses: 0 },
  { snapshotDate: "2026-08-14", dropRate: 0, medianDropPct: 0, panelSuburbs: 491, coverageRatio: 0.1, isGap: true, activeAddresses: 0, droppedAddresses: 0 },
  { snapshotDate: "2026-08-16", dropRate: 0.12, medianDropPct: 0.05, panelSuburbs: 499, coverageRatio: 1, isGap: false, activeAddresses: 0, droppedAddresses: 0 },
];

test("captions the panel so the number is quotable", () => {
  render(<DropIndexHero points={pts()} trackingSince="2026-08-03" />);
  expect(screen.getByText(/tracking since 3 Aug/i)).toBeInTheDocument();
  expect(screen.getByText(/499 suburbs/i)).toBeInTheDocument();
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
