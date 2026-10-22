import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render, screen } from "@testing-library/react";

import type { Metadata } from "next";

import EconomyStatePage, { generateMetadata } from "./page";
import { STATE_SLUGS } from "~/@/lib/economy/map-metrics";
import {
  ECONOMY_TOPICS,
  PUBLISHED_ECONOMY_TOPIC_PAIRS,
  economyTopicCopyForState,
  economyTopicHeadlineKey,
} from "~/@/lib/economy/topics";

const getEconomicSeries = jest.fn();
const bailOnEmptyRender = jest.fn();
const notFound = jest.fn(() => {
  throw new Error("NEXT_NOT_FOUND");
});

jest.mock("next/navigation", () => ({
  notFound: () => notFound(),
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
jest.mock("@/components/economy/economy-breadcrumbs", () => ({
  EconomyBreadcrumbs: () => null,
}));
jest.mock("@/components/economy/economy-icon", () => ({
  EconomyIcon: () => null,
}));
// next/link with the prefetch prop surfaced as data-prefetch so a test can read
// it, as the stock tab bar's tests do.
jest.mock("next/link", () => ({
  __esModule: true,
  default: ({
    children,
    href,
    prefetch,
    ...rest
  }: {
    children: React.ReactNode;
    href: string;
    prefetch?: boolean;
  }) => (
    <a href={href} data-prefetch={String(prefetch)} {...rest}>
      {children}
    </a>
  ),
}));
jest.mock("@/components/economy/state-banner", () => ({
  StateBanner: ({ name }: { name: string }) => <h1>{name} economy</h1>,
}));
jest.mock("@/components/economy/state-charts-loader", () => ({
  StateCharts: () => null,
}));
const llmMeta = jest.fn((props: { description: string; keywords?: string[] }) => {
  void props;
  return null;
});
jest.mock("@/components/seo/llm-meta", () => ({
  LLMMeta: (props: { description: string; keywords?: string[] }) => llmMeta(props),
}));

describe("economy state cross-domain links", () => {
  const source = readFileSync(resolve(__dirname, "page.tsx"), "utf8");

  it("links to the matching housing map and state-filtered price drops", () => {
    expect(source).toContain("href={`/housing/${state}`}");
    expect(source).toContain("href={`/price-drops?state=${state}`}");
  });

  it("keeps the existing chart-grid companies section instead of duplicating it", () => {
    expect(source).toContain("<StateCharts state={state} />");
    expect(source).not.toContain("StateCompanies");
  });

  it("does not read search params in the ISR server page", () => {
    expect(source).not.toContain("searchParams");
  });
});

/** The first day of a month, as the importers store a period. */
const period = (year: number, monthIndex: number) => ({
  seconds: BigInt(Date.UTC(year, monthIndex, 1) / 1000),
  nanos: 0,
});

const observed = (
  seriesKey: string,
  frequency: string,
  value: number,
  at: { seconds: bigint; nanos: number },
) => ({
  info: { seriesKey, frequency },
  observations: [{ period: at, value }],
});

// Victoria's newest readings as the API returned them on 2026-10-21.
const victoria = {
  series: [
    observed("labour.unemployment_rate.total.vic.seasadj", "monthly", 5.17267627, period(2026, 7)),
    observed("gdp.state_final_demand_chain_volume.total.vic.seasadj", "quarterly", 171_054_000_000, period(2026, 3)),
    observed("trade.export_value.total.vic", "monthly", 3_488_765_000, period(2026, 7)),
    observed("approvals.dwelling_units.total.vic", "monthly", 5075, period(2026, 6)),
    observed("business.sales.total.vic.seasadj", "quarterly", 235_548_000_000, period(2026, 3)),
    observed("construction.work_done.total.vic.seasadj", "quarterly", 19_733_659_000, period(2026, 3)),
    observed("lending.new_commitments.owner_occupier.vic.seasadj", "quarterly", 15_687_800_000, period(2026, 3)),
    observed("population.erp.total.vic", "quarterly", 7_154_221, period(2026, 0)),
    observed("spending.household.total.vic.seasadj", "monthly", 19_804_100_000, period(2026, 7)),
    observed("wages.wpi_yoy.vic", "quarterly", 3.1, period(2026, 3)),
  ],
};

const params = (state: string) => Promise.resolve({ state });

function topicHrefs() {
  return screen
    .getAllByRole("link")
    .map((link) => link.getAttribute("href"))
    .filter((href) => /^\/economy\/[a-z]+\/[a-z]+$/.test(href ?? ""));
}

describe("EconomyStatePage topics", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getEconomicSeries.mockResolvedValue(victoria);
  });

  it("links every published topic for the state, each with its latest reading", async () => {
    render(await EconomyStatePage({ params: params("vic") }));

    const published = PUBLISHED_ECONOMY_TOPIC_PAIRS.filter(
      (pair) => pair.state === "vic",
    );
    expect(published).toHaveLength(9);
    expect(topicHrefs()).toEqual(
      published.map(({ topic }) => `/economy/vic/${topic}`),
    );
    for (const { topic } of published) {
      const copy = economyTopicCopyForState(ECONOMY_TOPICS[topic], "vic");
      expect(screen.getByRole("link", { name: copy.h1 })).toHaveAttribute(
        "href",
        `/economy/vic/${topic}`,
      );
    }

    for (const sentence of [
      "The unemployment rate was 5.2% in Aug 2026 (seasonally adjusted).",
      "State final demand was $171.1B in Apr–Jun 2026 (chain volume, seasonally adjusted).",
      "Dwelling approvals totalled 5,075 in Jul 2026.",
      "Business sales were $235.5B in Apr–Jun 2026 (current prices, seasonally adjusted).",
      "Construction work done was $19.7B in Apr–Jun 2026 (chain volume, seasonally adjusted).",
      "New owner-occupier housing loan commitments were $15.7B in Apr–Jun 2026 (seasonally adjusted).",
      "The estimated resident population was 7,154,221 in Jan–Mar 2026.",
      "Household spending was $19.8B in Aug 2026 (current prices, seasonally adjusted).",
      "Annual wage growth was 3.1% in Apr–Jun 2026 (Wage Price Index).",
    ]) {
      expect(screen.getByText(sentence)).toBeInTheDocument();
    }
    expect(bailOnEmptyRender).not.toHaveBeenCalled();
  });

  it("reads the chips and every topic headline in one latest-only request", async () => {
    render(await EconomyStatePage({ params: params("vic") }));

    expect(getEconomicSeries).toHaveBeenCalledTimes(1);
    const [keys, maxObservations] = getEconomicSeries.mock.calls[0] as [
      string[],
      number,
    ];
    expect(maxObservations).toBe(1);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toEqual(
      expect.arrayContaining([
        "trade.export_value.total.vic",
        ...PUBLISHED_ECONOMY_TOPIC_PAIRS.filter((pair) => pair.state === "vic").map(
          ({ topic }) => economyTopicHeadlineKey(ECONOMY_TOPICS[topic], "vic"),
        ),
      ]),
    );
  });

  it("names a quarter by its months in the chips too", async () => {
    render(await EconomyStatePage({ params: params("vic") }));

    expect(screen.getByText("ABS, chain volume · Apr–Jun 2026")).toBeInTheDocument();
    expect(screen.getByText("ABS, seas. adj. · Aug 2026")).toBeInTheDocument();
  });

  // In view, the nine topic links would add about 140 KB gzipped of RSC
  // prefetches to each view and regenerate every stale topic page.
  it("turns off Link's own prefetch on every topic link", async () => {
    render(await EconomyStatePage({ params: params("vic") }));

    const links = screen
      .getAllByRole("link")
      .filter((link) =>
        /^\/economy\/vic\/[a-z]+$/.test(link.getAttribute("href") ?? ""),
      );
    expect(links).toHaveLength(9);
    for (const link of links) {
      expect(link).toHaveAttribute("data-prefetch", "false");
    }
  });

  it("omits the labour topic where the ABS publishes no labour family", async () => {
    getEconomicSeries.mockResolvedValue({ series: [] });
    render(await EconomyStatePage({ params: params("act") }));

    const hrefs = topicHrefs();
    expect(hrefs).toHaveLength(8);
    expect(hrefs).not.toContain("/economy/act/labour");
    expect(hrefs).toContain("/economy/act/wages");
  });

  it("keeps every link when the read fails, and does not cache that render for the hour", async () => {
    getEconomicSeries.mockResolvedValue(undefined);
    render(await EconomyStatePage({ params: params("vic") }));

    expect(topicHrefs()).toHaveLength(9);
    // Without a reading, the topic page's own description stands in.
    expect(
      screen.getByText(
        economyTopicCopyForState(ECONOMY_TOPICS.wages, "vic").description,
      ),
    ).toBeInTheDocument();
    expect(bailOnEmptyRender).toHaveBeenCalledTimes(1);
  });
});

// The title said "unemployment" on all eight pages and the description
// "diesel sales", but NT and ACT have no seasonally adjusted labour series (no
// unemployment chip) and ACT no diesel series (folded into NSW). Titles also
// rendered at 68-88 characters with the root template's " | Shorted".
describe("economy state metadata", () => {
  const meta = (state: string): Promise<Metadata> => generateMetadata({ params: params(state) });
  const rendered = (m: Metadata) => `${String(m.title)} | Shorted`;

  it("fits every state's rendered title in 65 characters, each distinct", async () => {
    const titles = await Promise.all(STATE_SLUGS.map(async (state) => rendered(await meta(state))));

    for (const title of titles) expect(title.length).toBeLessThanOrEqual(65);
    expect(new Set(titles).size).toBe(STATE_SLUGS.length);
  });

  it("names the state in full where it fits, and by its code where it does not", async () => {
    expect((await meta("vic")).title).toBe("Victoria economy — unemployment, final demand, trade");
    expect((await meta("nsw")).title).toBe("NSW economy — unemployment, final demand, trade");
    expect((await meta("nt")).title).toBe("Northern Territory economy — state final demand, trade");
    expect((await meta("act")).title).toBe("ACT economy — state final demand, trade");
  });

  it("promises unemployment only where the page reads it, and diesel only where it exists", async () => {
    for (const state of ["nt", "act"]) {
      expect(JSON.stringify(await meta(state))).not.toMatch(/unemployment/i);
    }
    expect(String((await meta("act")).description)).not.toMatch(/diesel|DCCEEW/);
    expect(String((await meta("nt")).description)).toContain("diesel sales");
    expect(String((await meta("vic")).description)).toBe(
      "Victoria economic snapshot: unemployment, state final demand, goods exports and imports, diesel sales and the ASX companies operating there — from ABS and DCCEEW open data.",
    );
  });

  it("keeps the Open Graph and Twitter titles with the page title", async () => {
    const m = await meta("qld");
    expect(m.openGraph?.title).toBe(m.title);
    expect(m.twitter?.title).toBe(m.title);
  });

  it("describes the ACT page's Dataset and LLM meta by what it reads", async () => {
    getEconomicSeries.mockResolvedValue({ series: [] });
    llmMeta.mockClear();
    const { container } = render(await EconomyStatePage({ params: params("act") }));

    const dataset = [...container.querySelectorAll('script[type="application/ld+json"]')]
      .map((s) => JSON.parse(s.textContent ?? "{}") as { "@type"?: string; description?: string })
      .find((d) => d["@type"] === "Dataset");
    expect(dataset?.description).toBe(
      "Australian Capital Territory: state final demand, goods exports and imports.",
    );
    const props = llmMeta.mock.calls.at(-1)![0];
    expect(props.description).not.toMatch(/unemployment|diesel|petroleum/i);
    expect(props.keywords?.join(" ")).not.toMatch(/unemployment/i);
  });
});
