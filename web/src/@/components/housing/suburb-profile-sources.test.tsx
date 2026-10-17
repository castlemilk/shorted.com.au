import { readFileSync } from "node:fs";
import { join } from "node:path";

import { render, screen } from "@testing-library/react";

import { SourcesLine } from "./suburb-profile";

/**
 * The provenance line is a licence obligation, not a caption. These pin the two
 * failure modes that matter: crediting a source the page never used (which is
 * what the old unconditional line did on every QLD/WA/TAS/NT suburb), and
 * dropping a link a licence requires.
 */
const base = {
  censusYear: 2021,
  hasCensus: false,
  hasPrice: false,
  hasAmenities: false,
  hasSchoolSectors: false,
  hasFederal: false,
  hasStateMember: false,
  stateName: "Queensland",
};

describe("SourcesLine", () => {
  it("credits only the datasets the page actually rendered", () => {
    render(<SourcesLine {...base} hasCensus />);
    expect(screen.getByText(/ABS Census 2021/)).toBeInTheDocument();
    expect(screen.getByText(/ABS ASGS boundaries/)).toBeInTheDocument();
    // A state with no Valuer-General feed must not be told it has one.
    expect(screen.queryByText(/Valuer-General/)).not.toBeInTheDocument();
    expect(screen.queryByText(/ACARA/)).not.toBeInTheDocument();
    expect(screen.queryByText(/OpenStreetMap/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Electoral Commission/)).not.toBeInTheDocument();
  });

  it("names the state whose Valuer-General supplied the price", () => {
    render(<SourcesLine {...base} hasPrice stateName="New South Wales" />);
    expect(
      screen.getByText(/New South Wales Valuer-General settled transfers/),
    ).toBeInTheDocument();
  });

  it("links OpenStreetMap's copyright page, as ODbL requires", () => {
    render(<SourcesLine {...base} hasAmenities />);
    const link = screen.getByRole("link", { name: /OpenStreetMap contributors/ });
    expect(link).toHaveAttribute("href", "https://www.openstreetmap.org/copyright");
    expect(screen.getByText(/ODbL/)).toBeInTheDocument();
  });

  it("attributes Wikipedia under CC BY-SA when a state member is shown", () => {
    render(<SourcesLine {...base} hasStateMember />);
    expect(screen.getByRole("link", { name: /Wikipedia/ })).toBeInTheDocument();
    expect(screen.getByText(/CC BY-SA 4\.0/)).toBeInTheDocument();
  });

  it("never collapses distinct licences into one blanket claim", () => {
    const { container } = render(
      <SourcesLine {...base} hasCensus hasPrice hasAmenities stateName="Victoria" />,
    );
    // ODbL and CC BY are different terms and must not be merged.
    expect(container.textContent).not.toContain("CC BY 4.0 / ODbL");
    expect(container.textContent).toContain("Not financial advice.");
  });
});

/**
 * SourcesLine can only be as honest as the flags handed to it, and the first
 * version shipped `hasPrice={Boolean(chartRegion) || priced}`. The backend
 * returns a region IDENTITY for suburbs with no published observation, so every
 * QLD and WA suburb — states with no Valuer-General feed — credited a
 * Valuer-General and rendered a rolling-median caption under a banner saying the
 * price was not tracked. Caught in production, not in review.
 *
 * String assertions on purpose: the failure mode is a one-token change to a
 * boolean, and it is completely silent at runtime.
 */
describe("suburb profile price gating", () => {
  const source = readFileSync(join(__dirname, "suburb-profile.tsx"), "utf8");

  it("gates the sources line on a real median, not on region identity", () => {
    expect(source).toContain("hasPrice={priced}");
    expect(source).not.toContain("hasPrice={Boolean(chartRegion)");
  });

  it("gates the price chart on a real median too", () => {
    expect(source).toContain("const chartRegion = priced ? regionForSeries : undefined;");
  });

  it("credits the terrain and hazard datasets only when their card rendered", () => {
    render(<SourcesLine {...base} hasTerrain hasWaterObservations statutoryHazardSources={["nsw_epi_flood", "nsw_bfpl", "nsw_bfpl"]} stateName="New South Wales" />);
    expect(screen.getByText(/Geoscience Australia 1 Second DEM-S/)).toBeInTheDocument();
    expect(screen.getByText(/DEA Water Observations Statistics/)).toBeInTheDocument();
    expect(screen.getByText(/NSW Environmental Planning Instrument — Flood/)).toBeInTheDocument();
    expect(screen.getAllByText(/NSW Bush Fire Prone Land/)).toHaveLength(1);
  });

  it("credits each state's statutory layer under its own licence", () => {
    render(<SourcesLine {...base} statutoryHazardSources={["sa_pdcode_hazards_flooding", "sa_pdcode_hazards_bushfire"]} stateName="South Australia" />);
    // The P&D Code overlays are CC BY 3.0 AU, not the CC BY 4.0 of the other states.
    expect(screen.getByText(/Hazards — Flooding, and Flooding — General\), Government of South Australia \(CC BY 3\.0 AU\)/)).toBeInTheDocument();
    expect(screen.getByText(/Hazards — Bushfire\), Government of South Australia \(CC BY 3\.0 AU\)/)).toBeInTheDocument();
  });

  it("credits VIC bushfire as the Designated Bushfire Prone Area, not the BMO", () => {
    render(<SourcesLine {...base} statutoryHazardSources={["vic_bpa"]} stateName="Victoria" />);
    expect(screen.getByText(/Designated Bushfire Prone Area.*\(CC BY 4\.0\)/)).toBeInTheDocument();
    expect(screen.queryByText(/Bushfire Management Overlay/)).not.toBeInTheDocument();
  });

  it("still credits the retired VIC BMO id, so a web deploy ahead of the data load keeps attribution", () => {
    render(<SourcesLine {...base} statutoryHazardSources={["vic_plan_overlay_bmo"]} stateName="Victoria" />);
    expect(screen.getByText(/Bushfire Management Overlay.*\(CC BY 4\.0\)/)).toBeInTheDocument();
  });

  it("credits no hazard dataset on a suburb without one", () => {
    render(<SourcesLine {...base} hasCensus />);
    expect(screen.queryByText(/DEM-S/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Water Observations/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Bush Fire Prone/)).not.toBeInTheDocument();
  });
});
