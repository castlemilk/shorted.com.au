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
    // A watch-only strategy has nothing triggered or set up to preview: every
    // strategy but Zanger here, four of the five.
    expect(screen.getAllByText("No stock is triggered or set up today.")).toHaveLength(
      STRATEGY_SLUGS.length - 1,
    );
  });

  // The rack: one list of five rows, each an article with its own glyph, so
  // the hub never reads as an identical icon-card grid; the key below teaches
  // the statuses as rule outcomes and the dot marks themselves.
  it("racks the five strategies as one hairline-divided list, with the printed key", async () => {
    render(await PicksHubPage());
    const section = screen.getByRole("region", { name: "Strategies" });
    const rack = section.querySelector("ol")!;
    expect(rack.className).toContain("divide-y");
    const items = within(rack)
      .getAllByRole("listitem")
      .filter((item) => item.querySelector("article") !== null);
    expect(items).toHaveLength(STRATEGY_SLUGS.length);
    for (const slug of STRATEGY_SLUGS) {
      expect(section.querySelector(`[data-strategy-glyph="${slug}"]`)).not.toBeNull();
    }
    // Every strategy but Zanger has nothing triggered: a dark readout window.
    const zero = within(section)
      .getAllByText("0")
      .filter((el) => el.tagName === "DD");
    expect(zero.length).toBeGreaterThan(0);
    for (const dd of zero) expect(dd.className).toContain("text-muted-foreground");

    for (const status of ["triggered", "setup", "watch"]) {
      expect(document.querySelector(`[data-status-chain="${status}"]`)).not.toBeNull();
    }
    expect(screen.getByText("Rule marks")).toBeInTheDocument();
    expect(screen.getByText("Pass")).toBeInTheDocument();
  });

  it("names all five strategies, quality compounders included", async () => {
    render(await PicksHubPage());
    expect(screen.getAllByRole("article")).toHaveLength(5);
    expect(getStrategyPicks).toHaveBeenCalledWith("quality-compounders");
    expect(
      screen.getByText(/or when the figure is not\s+meaningful for the company/),
    ).toBeInTheDocument();
  });

  it("states fundamentals coverage from the row count, as the strategy pages do", async () => {
    render(await PicksHubPage());
    // PICKS carries fundamentalsRowsCount 1203 >= fundamentalsCoverageCount 812.
    const line = screen.getByText(/fundamentals for/).closest("p")!;
    expect(line.textContent).toContain(
      "fundamentals for 1,203 of 1,904 stocks (growth figures for 812)",
    );
    expect(line.textContent).not.toContain("growth figures for 812 of 1,904");
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
