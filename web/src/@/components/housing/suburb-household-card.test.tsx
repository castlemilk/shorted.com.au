import { create } from "@bufbuild/protobuf";
import { render, screen, within } from "@testing-library/react";
import { StateCensusAveragesSchema, SuburbDemographicsSchema } from "~/gen/shorts/v1alpha1/housing_pb";
import { SuburbHousingStockCard, SuburbWhoLivesHereCard } from "./suburb-household-card";

const state = create(StateCensusAveragesSchema, {
  pctOwnedOutright: 31.4, pctOwnedMortgage: 32.6, pctRented: 32.7,
  pctSeparateHouse: 65, pctFlatApartment: 21.9,
  pctCoupleWithChildren: 28, pctLonePersonHousehold: 25,
  unemploymentRate: 5.1, labourForceParticipationRate: 60, pctBachelorOrHigher: 27.8,
  pctLowPersonalIncome: 24, pctHighPersonalIncome: 12,
});

// Bondi-shaped: mostly flats, mostly renters, a young educated workforce.
const bondi = create(SuburbDemographicsSchema, {
  population: 10_411, dwellingCount: 4_921,
  pctOwnedOutright: 17.2, pctOwnedMortgage: 17.9, pctRented: 61.3,
  pctSeparateHouse: 8.4, pctFlatApartment: 75.1,
  pctCoupleWithChildren: 17.8, pctLonePersonHousehold: 27.4,
  unemploymentRate: 3.2, labourForceParticipationRate: 78.3, pctBachelorOrHigher: 51.6,
  pctLowPersonalIncome: 14.1, pctHighPersonalIncome: 22.6,
});

describe("Housing stock", () => {
  test("dwellings, dwelling type and tenure, each against the state", () => {
    render(<SuburbHousingStockCard d={bondi} state={state} stateCode="NSW" />);
    expect(screen.getByRole("heading", { name: /Housing stock/ })).toBeInTheDocument();
    expect(screen.getByText("4,921")).toBeInTheDocument();

    const tenure = screen.getByRole("figure", { name: "Tenure" });
    expect(within(tenure).getByText("Rented")).toBeInTheDocument();
    expect(within(tenure).getByText("61%")).toBeInTheDocument();
    // 17 + 18 + 61 = 96: the Census remainder is named, not stretched away.
    expect(within(tenure).getByText("Other & not stated")).toBeInTheDocument();
    expect(within(tenure).getByText(/NSW: 31% owned outright · 33% mortgaged · 33% rented/)).toBeInTheDocument();

    const type = screen.getByRole("figure", { name: "Dwelling type" });
    expect(within(type).getByText("75%")).toBeInTheDocument();
  });

  test("renders nothing when the suburb has no dwelling data at all", () => {
    const tiny = create(SuburbDemographicsSchema, { population: 40 });
    const { container } = render(<SuburbHousingStockCard d={tiny} state={state} stateCode="NT" />);
    expect(container).toBeEmptyDOMElement();
    const { container: none } = render(<SuburbHousingStockCard d={undefined} state={state} stateCode="NT" />);
    expect(none).toBeEmptyDOMElement();
  });

  test("a withheld group is left out; a measured 0 inside a group is kept", () => {
    // 60 dwellings, tenure withheld (overfull), structure measured with no flats.
    const d = create(SuburbDemographicsSchema, { dwellingCount: 60, pctSeparateHouse: 97, pctFlatApartment: 0 });
    render(<SuburbHousingStockCard d={d} state={state} stateCode="WA" />);
    expect(screen.queryByRole("figure", { name: "Tenure" })).not.toBeInTheDocument();
    const type = screen.getByRole("figure", { name: "Dwelling type" });
    expect(within(type).getByText("0%")).toBeInTheDocument();
  });
});

describe("Who lives here", () => {
  test("every figure carries a percentage-point delta against the state", () => {
    render(<SuburbWhoLivesHereCard d={bondi} state={state} stateCode="NSW" />);
    expect(screen.getByRole("heading", { name: /Who lives here/ })).toBeInTheDocument();
    expect(screen.getByText("Bachelor degree or higher").parentElement).toHaveTextContent("52%+24 pts vs NSW");
    expect(screen.getByText("Unemployment").parentElement).toHaveTextContent("3%−2 pts vs NSW");
    expect(screen.getByText("Earning $2,000+ a week")).toBeInTheDocument();
    expect(screen.queryByText(/% vs NSW/)).not.toBeInTheDocument(); // points, never a percent change
  });

  test("a standalone rate at 0 is withheld, not published as 0%", () => {
    const d = create(SuburbDemographicsSchema, { pctCoupleWithChildren: 30, pctLonePersonHousehold: 20 });
    render(<SuburbWhoLivesHereCard d={d} state={state} stateCode="QLD" />);
    expect(screen.getByText("Couples with children")).toBeInTheDocument();
    expect(screen.queryByText("Unemployment")).not.toBeInTheDocument();
    expect(screen.queryByText("Bachelor degree or higher")).not.toBeInTheDocument();
  });

  test("renders nothing when every figure was withheld, and omits deltas without a state reference", () => {
    const { container } = render(<SuburbWhoLivesHereCard d={create(SuburbDemographicsSchema, { population: 60 })} state={state} stateCode="NT" />);
    expect(container).toBeEmptyDOMElement();

    render(<SuburbWhoLivesHereCard d={bondi} state={undefined} stateCode="NSW" />);
    expect(screen.getByText("Unemployment")).toBeInTheDocument();
    expect(screen.queryByText(/vs NSW/)).not.toBeInTheDocument();
  });
});
