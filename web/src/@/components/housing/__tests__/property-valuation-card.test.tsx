import { create } from "@bufbuild/protobuf";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { getPropertyHistoryClient } from "~/app/actions/client/getHousingClient";
import {
  GetPropertyHistoryResponseSchema,
  PropertyValuationSchema,
  type PropertyValuation,
} from "~/gen/shorts/v1alpha1/housing_pb";
import { PropertyHistoryView } from "../property-history-view";
import { PropertyValuationCard } from "../property-valuation-card";

jest.mock("~/app/actions/client/getHousingClient", () => ({
  getPropertyHistoryClient: jest.fn(),
}));

// The shared Jest setup intentionally stubs @radix-ui/react-context without
// createContextScope, so render this test's existing shadcn tooltip boundary as
// simple wrappers while still asserting the card's tooltip copy.
jest.mock("@/components/ui/tooltip", () => {
  const React = require("react");
  const Wrapper = ({ children }: { children: ReactElement }) =>
    React.createElement(React.Fragment, null, children);
  return {
    Tooltip: Wrapper,
    TooltipContent: Wrapper,
    TooltipProvider: Wrapper,
    TooltipTrigger: Wrapper,
  };
});

const mockGetPropertyHistoryClient =
  getPropertyHistoryClient as jest.MockedFunction<
    typeof getPropertyHistoryClient
  >;

function valuation(
  overrides: Partial<PropertyValuation> = {},
): PropertyValuation {
  return create(PropertyValuationSchema, {
    source: "property.com.au",
    profileUrl:
      "https://www.property.com.au/vic/richmond-3121/smith-st/1-pid-1/",
    fetchedAt: "2026-07-20T09:30:00Z",
    estimateLow: 1_200_000,
    estimateMid: 1_300_000,
    estimateHigh: 1_400_000,
    estimateConfidence: "High",
    valuationGranularity: "exact",
    rentEstimateMid: 620,
    bedrooms: 3,
    bathrooms: 2,
    carSpaces: 1,
    landSizeSqm: 450,
    buildingSizeSqm: 180,
    yearBuilt: 1998,
    propertyType: "house",
    salesHistory: [],
    ...overrides,
  });
}

function renderWithQueryClient(ui: ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>,
  );
}

describe("PropertyValuationCard", () => {
  beforeEach(() => {
    mockGetPropertyHistoryClient.mockReset();
  });

  it("renders an exact estimate with range and free-form confidence", () => {
    render(<PropertyValuationCard valuation={valuation()} />);

    expect(
      screen.getByRole("heading", { name: "Estimated value" }),
    ).toBeInTheDocument();
    expect(screen.getByText("$1.3M")).toBeInTheDocument();
    expect(screen.getByText("$1.2M – $1.4M range")).toBeInTheDocument();
    expect(screen.getByText("high confidence")).toBeInTheDocument();
    expect(screen.queryByText("Building estimate")).not.toBeInTheDocument();
  });

  it("labels a whole-building estimate beside the price and inline", () => {
    render(
      <PropertyValuationCard
        valuation={valuation({ valuationGranularity: "building" })}
      />,
    );

    expect(screen.getByText("Building estimate")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Whole-building estimate — this specific unit isn’t individually valued.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "This unit isn’t individually indexed by the valuation source, so this is the estimate for the whole building — not this specific unit.",
      ),
    ).toBeInTheDocument();
  });

  it("renders source attributes without a price block when no estimate exists", () => {
    render(
      <PropertyValuationCard
        valuation={valuation({
          estimateLow: 0,
          estimateMid: 0,
          estimateHigh: 0,
          estimateConfidence: "",
        })}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Property details" }),
    ).toBeInTheDocument();
    expect(screen.getByText("3 bd · 2 ba · 1 car")).toBeInTheDocument();
    expect(screen.getByText("450m² land")).toBeInTheDocument();
    expect(screen.getByText("180m² floor")).toBeInTheDocument();
    expect(screen.getByText("Built 1998")).toBeInTheDocument();
    expect(screen.getByText("house")).toBeInTheDocument();
    expect(screen.queryByText("$0")).not.toBeInTheDocument();
  });

  it("keeps source sales history separate and labels undisclosed prices", () => {
    render(
      <PropertyValuationCard
        valuation={valuation({
          salesHistory: [
            {
              $typeName: "shorts.v1alpha1.PropertyValuationSale",
              date: "2019-05-11",
              price: 980_000,
              agency: "Test Realty",
              eventType: "Sold",
            },
            {
              $typeName: "shorts.v1alpha1.PropertyValuationSale",
              date: "2015-02-02",
              price: 0,
              agency: "",
              eventType: "Listed for sale",
            },
          ],
        })}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Sales history" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Sold")).toBeInTheDocument();
    expect(screen.getByText("$980k")).toBeInTheDocument();
    expect(screen.getByText("Test Realty")).toBeInTheDocument();
    expect(screen.getByText("Price undisclosed")).toBeInTheDocument();
  });

  it("caps long sales history at eight rows until expanded", async () => {
    const user = userEvent.setup();
    const salesHistory = Array.from({ length: 9 }, (_, index) => ({
      $typeName: "shorts.v1alpha1.PropertyValuationSale" as const,
      date: `20${10 + index}-01-01`,
      price: 500_000 + index,
      agency: "",
      eventType: "Sold",
    }));

    render(<PropertyValuationCard valuation={valuation({ salesHistory })} />);

    expect(screen.queryByText("1 Jan 2018")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Show all (9)" }));
    expect(screen.getByText("1 Jan 2018")).toBeInTheDocument();
  });

  it("is absent from property history when the response has no valuation", async () => {
    mockGetPropertyHistoryClient.mockResolvedValue(
      create(GetPropertyHistoryResponseSchema, {
        addressKey: "1-smith-street-richmond-vic-3121",
        displayAddress: "1 Smith Street",
        suburb: "Richmond",
        stateCode: "VIC",
        postcode: "3121",
        current: {
          source: "rea",
          listingId: "listing-1",
          listingUrl: "https://realestate.com.au/listing-1",
          price: 1_200_000,
          listingStatus: "for_sale",
          isActive: true,
          firstSeenAt: "2026-07-01T00:00:00Z",
          lastSeenAt: "2026-07-20T00:00:00Z",
        },
        events: [],
        numListings: 1,
        firstPrice: 1_200_000,
        currentPrice: 1_200_000,
      }),
    );

    renderWithQueryClient(
      <PropertyHistoryView addressKey="1-smith-street-richmond-vic-3121" />,
    );

    expect(await screen.findByText("1 Smith Street")).toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.queryByRole("heading", { name: "Estimated value" }),
      ).not.toBeInTheDocument(),
    );
  });

  it("renders the valuation returned with property history", async () => {
    mockGetPropertyHistoryClient.mockResolvedValue(
      create(GetPropertyHistoryResponseSchema, {
        addressKey: "1-smith-street-richmond-vic-3121",
        displayAddress: "1 Smith Street",
        suburb: "Richmond",
        stateCode: "VIC",
        postcode: "3121",
        current: {
          source: "rea",
          listingId: "listing-1",
          listingUrl: "https://realestate.com.au/listing-1",
          price: 1_200_000,
          listingStatus: "for_sale",
          isActive: true,
          firstSeenAt: "2026-07-01T00:00:00Z",
          lastSeenAt: "2026-07-20T00:00:00Z",
        },
        events: [],
        numListings: 1,
        firstPrice: 1_200_000,
        currentPrice: 1_200_000,
        valuation: valuation(),
      }),
    );

    renderWithQueryClient(
      <PropertyHistoryView addressKey="1-smith-street-richmond-vic-3121" />,
    );

    expect(
      await screen.findByRole("heading", { name: "Estimated value" }),
    ).toBeInTheDocument();
  });
});
