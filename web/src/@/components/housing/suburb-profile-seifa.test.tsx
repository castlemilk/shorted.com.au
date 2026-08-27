import { create } from "@bufbuild/protobuf";
import { render, screen, within } from "@testing-library/react";
import {
  GetSuburbProfileResponseSchema,
  type SuburbSeifa,
  SuburbSeifaIndexSchema,
  SuburbSeifaSchema,
  SuburbSummarySchema,
} from "~/gen/shorts/v1alpha1/housing_pb";
import { SuburbProfile } from "./suburb-profile";

jest.mock("./suburb-banner-map", () => ({ SuburbBannerMap: () => null }));
jest.mock("./housing-charts", () => ({ HousingSeriesChart: () => null }));
jest.mock("./suburb-locator-map-loader", () => ({ SuburbLocatorMap: () => null }));
jest.mock("./suburb-recent-price-drops-loader", () => ({ RecentPriceDrops: () => null }));
jest.mock("@/components/politicians/suburb-politician-property-card-loader", () => ({
  SuburbPoliticianPropertyCard: () => null,
}));

const seifaIndex = (score: number, decileAus: number, decileState: number) =>
  create(SuburbSeifaIndexSchema, { score, decileAus, decileState });

const profileWithSeifa = (seifa?: SuburbSeifa) =>
  create(GetSuburbProfileResponseSchema, {
    summary: create(SuburbSummarySchema, {
      salCode: "SAL12865",
      salName: "MOSMAN",
      postcode: "2088",
      stateCode: "NSW",
      seifa,
    }),
  });

const mosmanProfile = profileWithSeifa(
  create(SuburbSeifaSchema, {
    irsd: seifaIndex(1110, 10, 10),
    irsad: seifaIndex(1169, 10, 10),
    ier: seifaIndex(1065, 8, 8),
    ieo: seifaIndex(1185, 10, 10),
  }),
);

test("renders all four SEIFA indexes with their score and national and state deciles", () => {
  render(<SuburbProfile salCode="SAL12865" profile={mosmanProfile} />);

  expect(
    screen.getByRole("heading", { name: "Socio-economic profile" }),
  ).toBeInTheDocument();

  const expected = [
    { name: /IRSAD/, score: "1,169", aus: 10, state: 10 },
    { name: /IRSD/, score: "1,110", aus: 10, state: 10 },
    { name: /IER/, score: "1,065", aus: 8, state: 8 },
    { name: /IEO/, score: "1,185", aus: 10, state: 10 },
  ];

  for (const index of expected) {
    const card = screen.getByRole("article", { name: index.name });
    expect(card).toHaveTextContent(`Score ${index.score}`);
    expect(within(card).getByText("Within Australia")).toBeInTheDocument();
    expect(card).toHaveTextContent(`Decile ${index.aus} of 10`);
    expect(within(card).getByText("Within New South Wales")).toBeInTheDocument();
    expect(card).toHaveTextContent(`Decile ${index.state} of 10`);
  }
});

test("renders no SEIFA section when data is absent or every index is zeroed", () => {
  const { rerender } = render(
    <SuburbProfile salCode="SAL12865" profile={profileWithSeifa()} />,
  );
  expect(
    screen.queryByRole("heading", { name: "Socio-economic profile" }),
  ).not.toBeInTheDocument();

  const zeroed = create(SuburbSeifaSchema, {
    irsad: seifaIndex(0, 0, 0),
    irsd: seifaIndex(0, 0, 0),
    ier: seifaIndex(0, 0, 0),
    ieo: seifaIndex(0, 0, 0),
  });
  rerender(
    <SuburbProfile salCode="SAL12865" profile={profileWithSeifa(zeroed)} />,
  );
  expect(
    screen.queryByRole("heading", { name: "Socio-economic profile" }),
  ).not.toBeInTheDocument();
});

test("renders a populated index and omits a zeroed index without exposing zero sentinels", () => {
  const partial = create(SuburbSeifaSchema, {
    irsad: seifaIndex(757, 1, 1),
    ieo: seifaIndex(0, 0, 0),
  });
  const { container } = render(
    <SuburbProfile salCode="SAL12865" profile={profileWithSeifa(partial)} />,
  );

  expect(screen.getByRole("article", { name: /IRSAD/ })).toBeInTheDocument();
  expect(screen.queryByRole("article", { name: /IEO/ })).not.toBeInTheDocument();
  expect(container).toHaveTextContent("Score 757");
  expect(container).toHaveTextContent("Decile 1 of 10");
  expect(container).not.toHaveTextContent(/Score 0/);
  expect(container).not.toHaveTextContent(/Decile 0/);
});

test("explains IRSD's inverted sense without presenting it as an advantage index", () => {
  render(<SuburbProfile salCode="SAL12865" profile={mosmanProfile} />);

  const irsd = screen.getByRole("article", { name: /IRSD/ });
  expect(irsd).toHaveTextContent(/disadvantage only/i);
  expect(irsd).toHaveTextContent(/higher score means less disadvantage/i);
  expect(irsd).not.toHaveTextContent(/advantage index/i);
});

test("explains the standardised scale and carries the ABS SEIFA attribution", () => {
  const { container } = render(
    <SuburbProfile salCode="SAL12865" profile={mosmanProfile} />,
  );

  expect(container).toHaveTextContent(
    "Scores are standardised across Australia to a mean of 1,000 and a standard deviation of 100.",
  );
  expect(container).toHaveTextContent(
    "Deciles run from 1 (most disadvantaged) to 10 (least disadvantaged).",
  );
  expect(container).toHaveTextContent("ABS SEIFA 2021 (CC BY 4.0)");
});
