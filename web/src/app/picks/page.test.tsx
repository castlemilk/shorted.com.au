import { render, screen, within } from "@testing-library/react";

import PicksHubPage from "./page";
import { STRATEGY_SLUGS } from "~/@/lib/strategies/registry";
import {
  PICKS,
  SETUP,
  TRIGGERED,
  UPTREND,
  WATCH,
  ZANGER,
} from "~/@/components/picks/__tests__/fixtures";

const getStrategies = jest.fn();
const getStrategyPicks = jest.fn();
const bailOnEmptyRender = jest.fn();

jest.mock("~/@/components/layouts/dashboard-layout", () => ({
  DashboardLayout: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
}));
jest.mock("~/@/components/seo/breadcrumbs", () => ({
  Breadcrumbs: () => null,
}));
jest.mock("~/@/components/seo/enhanced-structured-data", () => ({
  BreadcrumbListSchema: () => null,
  ItemListStructuredData: ({ items }: { items: unknown[] }) => (
    <div data-testid="itemlist">{items.length}</div>
  ),
}));
jest.mock("~/app/actions/config", () => ({
  bailOnEmptyRender: () => bailOnEmptyRender(),
}));
jest.mock("~/app/actions/getStrategies", () => ({
  getStrategies: () => getStrategies(),
}));
jest.mock("~/app/actions/getStrategyPicks", () => ({
  getStrategyPicks: (...args: unknown[]) => getStrategyPicks(...args),
}));

const NEUTRAL_VERDICT =
  "Uptrend: XJO is above its 50-day average, with the 50-day above the 200-day.";

describe("PicksHubPage", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getStrategies.mockResolvedValue({
      strategies: [ZANGER],
      regime: { ...UPTREND, verdict: NEUTRAL_VERDICT },
    });
    getStrategyPicks.mockImplementation(async (id: string) =>
      id === "zanger-breakout"
        ? PICKS
        : {
            ...PICKS,
            strategy: { ...ZANGER, id, name: `Strategy ${id}`, author: "Someone Else" },
            picks: [WATCH],
          },
    );
  });

  it("renders the hub header, regime banner and one card per strategy", async () => {
    render(await PicksHubPage());

    expect(
      screen.getByRole("heading", { level: 1, name: "ASX Stock Picker" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Choose a named strategy/)).toBeInTheDocument();
    expect(screen.getByText(NEUTRAL_VERDICT)).toBeInTheDocument();
    expect(screen.getAllByText(/Not financial advice/).length).toBeGreaterThan(0);

    for (const slug of STRATEGY_SLUGS) {
      expect(getStrategyPicks).toHaveBeenCalledWith(slug);
    }
    const links = screen.getAllByRole("link").map((a) => a.getAttribute("href"));
    for (const slug of STRATEGY_SLUGS) {
      expect(links).toContain(`/picks/${slug}`);
    }
    expect(screen.getByTestId("itemlist")).toHaveTextContent(
      String(STRATEGY_SLUGS.length),
    );
    expect(bailOnEmptyRender).not.toHaveBeenCalled();
  });

  it("shows counts and the top triggered or setup names with logos", async () => {
    render(await PicksHubPage());

    const card = screen
      .getByRole("heading", { level: 2, name: "Zanger Breakout" })
      .closest("article")!;
    const scoped = within(card);
    expect(scoped.getByText("Dan Zanger")).toBeInTheDocument();
    expect(scoped.getByText(ZANGER.tagline)).toBeInTheDocument();
    const leaders = within(scoped.getByRole("list", { name: "Top Zanger Breakout picks" }));
    expect(leaders.getAllByRole("link").map((a) => a.textContent)).toEqual([
      TRIGGERED.code,
      SETUP.code,
    ]);
    expect(leaders.getAllByTestId("stock-logo")).toHaveLength(2);
    // A watch-only strategy has nothing triggered or set up to preview.
    expect(screen.getAllByText("No stock is triggered or set up today.")).toHaveLength(3);
  });

  it("falls back to registry copy and bails the render when the API is down", async () => {
    getStrategies.mockResolvedValue(null);
    getStrategyPicks.mockResolvedValue(null);

    render(await PicksHubPage());

    expect(screen.getAllByRole("article")).toHaveLength(STRATEGY_SLUGS.length);
    expect(screen.getByText(/Live picks are temporarily unavailable/)).toBeInTheDocument();
    expect(screen.getByText(/Market regime unavailable/)).toBeInTheDocument();
    expect(bailOnEmptyRender).toHaveBeenCalledTimes(1);
  });
});
