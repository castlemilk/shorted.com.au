import { render, screen } from "@testing-library/react";

import EconomyPage from "./page";
import { STATE_NAMES, STATE_SLUGS } from "~/@/lib/economy/map-metrics";
import {
  ECONOMY_TOPICS,
  PUBLISHED_ECONOMY_TOPIC_PAIRS,
} from "~/@/lib/economy/topics";

const getEconomicSeries = jest.fn();
const bailOnEmptyRender = jest.fn();

// React 18.3's react-dom has no preload (Next bundles a canary that does).
jest.mock("react-dom", () => ({
  ...jest.requireActual("react-dom"),
  preload: jest.fn(),
}));
jest.mock("~/@/components/layouts/dashboard-layout", () => ({
  DashboardLayout: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
}));
jest.mock("~/app/actions/getEconomy", () => ({
  getEconomicSeries: (...args: unknown[]) => getEconomicSeries(...args),
}));
jest.mock("~/app/actions/config", () => ({
  bailOnEmptyRender: () => bailOnEmptyRender(),
}));
jest.mock("@/components/economy/economy-charts", () => ({
  EconomySeriesChart: () => null,
}));
jest.mock("@/components/economy/economy-icon", () => ({
  EconomyIcon: () => null,
}));
jest.mock("@/components/economy/economy-map-loader", () => ({
  EconomyMapExplorer: () => null,
}));
jest.mock("@/components/housing/when-visible", () => ({
  WhenVisible: () => null,
}));
jest.mock("@/components/seo/llm-meta", () => ({
  LLMMeta: () => null,
}));

const cashRate = {
  series: [
    {
      info: { seriesKey: "rates.cash_rate_target.aus", frequency: "monthly" },
      observations: [
        {
          period: { seconds: BigInt(Date.UTC(2026, 8, 1) / 1000), nanos: 0 },
          value: 3.6,
        },
      ],
    },
  ],
};

describe("EconomyPage", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getEconomicSeries.mockResolvedValue(cashRate);
  });

  it("server-renders a link to every state page and every published topic page", async () => {
    render(await EconomyPage());

    const hrefs = screen
      .getAllByRole("link")
      .map((link) => link.getAttribute("href"));
    for (const state of STATE_SLUGS) {
      expect(
        screen.getByRole("link", { name: STATE_NAMES[state] }),
      ).toHaveAttribute("href", `/economy/${state}`);
    }
    const topicHrefs = hrefs.filter((href) =>
      /^\/economy\/[a-z]+\/[a-z]+$/.test(href ?? ""),
    );
    expect(topicHrefs).toEqual(
      PUBLISHED_ECONOMY_TOPIC_PAIRS.map(
        ({ state, topic }) => `/economy/${state}/${topic}`,
      ),
    );
    expect(topicHrefs).toHaveLength(70);
    expect(
      screen.getAllByRole("link", { name: ECONOMY_TOPICS.wages.name }),
    ).toHaveLength(STATE_SLUGS.length);
  });

  it("asks for only the newest observation of each headline series", async () => {
    render(await EconomyPage());

    expect(getEconomicSeries).toHaveBeenCalledWith(expect.any(Array), 1);
    expect(screen.getByText("3.60%")).toBeInTheDocument();
    expect(bailOnEmptyRender).not.toHaveBeenCalled();
  });
});
