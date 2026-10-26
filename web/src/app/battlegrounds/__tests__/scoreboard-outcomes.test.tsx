import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

// The scoreboard says what the share price did after a short-interest peak.
// It must not score short sellers ("Shorts won", "Shorts were right"): a lower
// price is not a short seller's result, which the peaks study
// (web/_blogs/what-happens-after-asx-short-interest-peaks.mdx) spells out.

// next/image needs a base URL its loader can resolve, which jsdom does not
// provide. Mocked the same way consent-screen.test.tsx does it.
jest.mock("next/image", () => ({
  __esModule: true,
  default: (props: { src: string; alt?: string }) => (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={props.src} alt={props.alt ?? ""} />
  ),
}));

// Generated code is outside jest's module path (modulePathIgnorePatterns).
jest.mock("~/gen/shorts/v1alpha1/market_pb", () => ({
  BattlegroundView: { UNSPECIFIED: 0, SQUEEZE: 1, DIVERGENCE: 2 },
}));

// Radix Tabs needs the real @radix-ui/react-context, which src/test/setup.ts
// stubs out, so the tabs become plain buttons that switch the view.
jest.mock("~/@/components/ui/tabs", () => {
  const { createContext, useContext } =
    jest.requireActual<typeof import("react")>("react");
  const SelectView = createContext<(value: string) => void>(() => undefined);
  return {
    Tabs: ({
      onValueChange,
      children,
    }: {
      onValueChange: (value: string) => void;
      children: ReactNode;
    }) => (
      <SelectView.Provider value={onValueChange}>
        {children}
      </SelectView.Provider>
    ),
    TabsList: ({ children }: { children: ReactNode }) => (
      <div role="tablist">{children}</div>
    ),
    TabsTrigger: ({
      value,
      children,
    }: {
      value: string;
      children: ReactNode;
    }) => {
      const selectView = useContext(SelectView);
      return (
        <button type="button" role="tab" onClick={() => selectView(value)}>
          {children}
        </button>
      );
    },
  };
});

const mockGetScoreboard = jest.fn();
jest.mock("~/app/actions/client/getScoreboardClient", () => ({
  getScoreboardClient: (...args: unknown[]) =>
    mockGetScoreboard(...args) as unknown,
}));
jest.mock("~/app/actions/client/getBattlegroundsClient", () => ({
  getBattlegroundsClient: jest.fn(),
}));

import { BattlegroundsClient } from "../battlegrounds-client";

/** A ShortCampaign as the RPC returns it: unset numbers are 0, flags false. */
function campaign(stockCode: string, fields: Record<string, number | boolean>) {
  return {
    stockCode,
    companyName: `${stockCode} Ltd`,
    industry: "",
    logoUrl: "",
    peakDate: "2025-04-09",
    peakShortPct: 12,
    priceAtPeak: 1,
    currentShortPct: 5,
    latestPrice: 1,
    return3m: 0,
    return6m: 0,
    has3m: false,
    has6m: false,
    shortsWon3m: false,
    shortsWon6m: false,
    ...fields,
  };
}

function outcomeCell(stockCode: string): HTMLElement {
  const row = screen
    .getAllByRole("row")
    .find((r) => within(r).queryByText(stockCode, { exact: true }));
  if (!row) throw new Error(`no scoreboard row for ${stockCode}`);
  const cells = within(row).getAllByRole("cell");
  return cells[cells.length - 1]!;
}

describe("Battlegrounds scoreboard", () => {
  beforeEach(() => {
    mockGetScoreboard.mockResolvedValue({
      campaigns: [
        campaign("LOW", {
          has3m: true,
          has6m: true,
          return3m: -12.5,
          return6m: -26.17,
          shortsWon3m: true,
          shortsWon6m: true,
        }),
        campaign("UP", {
          has3m: true,
          has6m: true,
          return3m: 8.1,
          return6m: 119.7,
        }),
        // PNV on 21 October 2026: 0.945 at the peak and 0.945 three months
        // later, with no six-month window yet. The view's strict "lower" flag
        // is false, but the price did not rise either.
        campaign("FLAT", { has3m: true, return3m: 0 }),
        campaign("NEW", {}),
      ],
      totalCount: 4,
      campaignsTotal: 255,
      shortsWinRate3m: 39.5,
      shortsWinRate6m: 43,
    });
  });

  it("describes price moves after the peak, never short sellers' wins", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <BattlegroundsClient initialRows={[]} initialTotalCount={0} />
      </QueryClientProvider>,
    );

    await userEvent.click(screen.getByRole("tab", { name: "Scoreboard" }));

    expect(
      await screen.findByText(
        "Price lower 3 months after the peak in 40% of campaigns",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Price lower 6 months after the peak in 43% of campaigns",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /Every priced row, ETFs and bonds included, on closes not adjusted for dividends\./,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", {
        name: "what happens after short interest peaks",
      }),
    ).toHaveAttribute(
      "href",
      "/blog/what-happens-after-asx-short-interest-peaks",
    );

    expect(outcomeCell("LOW")).toHaveTextContent(/^Price lower$/);
    expect(outcomeCell("UP")).toHaveTextContent(/^Price higher$/);
    expect(outcomeCell("FLAT")).toHaveTextContent(/^Price unchanged$/);
    expect(outcomeCell("NEW")).toHaveTextContent(/^—$/);

    expect(document.body).not.toHaveTextContent(
      /shorts (won|lost|were right)/i,
    );
  });
});
