import { render, screen, within } from "@testing-library/react";

import StrategyRulesPage, { generateMetadata, revalidate } from "./page";
import type {
  StrategiesResult,
  StrategyDef,
  StrategyVersionDetailView,
} from "~/@/lib/strategies/types";

const getStrategies = jest.fn();
const getStrategyVersion = jest.fn();
const listStrategyVersions = jest.fn();
const bailOnEmptyRender = jest.fn(async () => undefined);
const notFound = jest.fn(() => {
  throw new Error("NEXT_NOT_FOUND");
});

jest.mock("next/navigation", () => ({
  notFound: () => notFound(),
}));
jest.mock("~/app/actions/getStrategies", () => ({
  getStrategies: () => getStrategies(),
}));
jest.mock("~/app/actions/strategies/getStrategyVersion", () => ({
  getStrategyVersion: (...args: unknown[]) => getStrategyVersion(...args),
}));
jest.mock("~/app/actions/strategies/listStrategyVersions", () => ({
  listStrategyVersions: () => listStrategyVersions(),
}));
jest.mock("~/app/actions/config", () => ({
  bailOnEmptyRender: () => bailOnEmptyRender(),
}));

const HASH = "3f9a1c2e" + "b".repeat(56);
const OLD_HASH = "0a1b2c3d" + "c".repeat(56);

const CANSLIM_RULE_TEXT = "Earnings are accelerating, in the author's own words.";
const CANSLIM_EVALUATION = "Our test: quarterly EPS growth of at least 25 per cent.";

const canslim: StrategyDef = {
  id: "canslim",
  name: "CAN SLIM",
  author: "William O'Neil",
  tagline: "",
  descriptionParagraphs: [],
  rules: [
    {
      id: "growth",
      title: "Earnings growth",
      ruleText: CANSLIM_RULE_TEXT,
      evaluation: CANSLIM_EVALUATION,
      core: true,
      dataSource: "stock_fundamentals",
      trigger: false,
      weight: 0.25,
    },
    {
      id: "new_high",
      title: "Near a new high",
      ruleText: "A price at its high.",
      evaluation: "Within 15 points of the 52-week high.",
      core: true,
      dataSource: "stock_prices",
      trigger: true,
      weight: 0.2,
    },
    {
      id: "leader",
      title: "Market leader",
      ruleText: "Leads the market.",
      evaluation: "Top quartile on 6-month relative strength.",
      core: false,
      dataSource: "stock_prices",
      trigger: false,
      weight: 0,
    },
  ],
  metadata: null,
  caveats: [],
  sources: [],
};

function version(
  strategyId: string,
  rulesHash: string,
  overrides: Partial<StrategyVersionDetailView> = {},
): StrategyVersionDetailView {
  return {
    version: {
      strategyId,
      label: "v0",
      rulesHash,
      engineVersion: "1.0.0",
      featureSet: "fs1",
      status: "live",
      liveFrom: "2026-11-03",
      kind: "canonical",
      variantId: "",
    },
    params: [
      { ruleId: "growth", name: "min_pct", value: 25 },
      { ruleId: "new_high", name: "max_off_pct", value: 15 },
      { ruleId: "new_high", name: "fraction", value: 0.8 },
    ],
    rules: [
      { ruleId: "growth", core: true, trigger: false, weight: 0.25 },
      { ruleId: "new_high", core: true, trigger: true, weight: 0.2 },
      { ruleId: "leader", core: false, trigger: false, weight: 0 },
    ],
    policies: ["Candidates are ordinary shares only."],
    changes: ["Initial version."],
    knownIssues: ["A recent issuer can read as unknown."],
    supersededOn: "",
    retiredOn: "",
    ...overrides,
  };
}

const catalogue: StrategiesResult = { strategies: [canslim], regime: null };

describe("the Rules tab", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getStrategies.mockResolvedValue(catalogue);
    getStrategyVersion.mockResolvedValue(version("canslim", HASH));
    listStrategyVersions.mockResolvedValue([
      version("canslim", OLD_HASH, {
        version: {
          strategyId: "canslim",
          label: "v0",
          rulesHash: OLD_HASH,
          engineVersion: "1.0.0",
          featureSet: "fs1",
          status: "superseded",
          liveFrom: "",
          kind: "canonical",
          variantId: "",
        },
        changes: ["Earlier wording."],
        supersededOn: "2026-11-03",
      }),
      version("canslim", HASH),
      version("zanger-breakout", "9e8d7c6b" + "d".repeat(56)),
    ]);
  });

  it("is an indexable ISR page with its own canonical URL and card, and no robots override", async () => {
    expect(revalidate).toBe(3600);
    const meta = await generateMetadata({
      params: Promise.resolve({ strategy: "canslim" }),
    });
    expect(meta.alternates?.canonical).toBe("https://shorted.com.au/strategies/canslim/rules");
    expect(meta.alternates?.languages).toEqual({
      "en-AU": "https://shorted.com.au/strategies/canslim/rules",
      "x-default": "https://shorted.com.au/strategies/canslim/rules",
    });
    expect(meta.title).toBe("Rules: CAN SLIM Strategy");
    expect(meta).not.toHaveProperty("robots");
    expect(meta.openGraph).toEqual(
      expect.objectContaining({
        images: [expect.objectContaining({ url: "/strategies/canslim/opengraph-image" })],
      }),
    );
  });

  it("answers an unknown strategy with a 404 and reads nothing", async () => {
    await expect(
      StrategyRulesPage({ params: Promise.resolve({ strategy: "nope" }) }),
    ).rejects.toThrow("NEXT_NOT_FOUND");
    expect(getStrategyVersion).not.toHaveBeenCalled();
  });

  it("states every parameter of the live version against its rule, with its role and weight", async () => {
    const { container } = render(await StrategyRulesPage({ params: Promise.resolve({ strategy: "canslim" }) }));

    expect(screen.getByRole("heading", { level: 2, name: "Parameters" })).toBeInTheDocument();
    const table = screen.getByRole("table");
    const growth = within(table).getByRole("rowheader", { name: "Earnings growth" }).closest("tr")!;
    expect(within(growth).getByText("Core")).toBeInTheDocument();
    expect(within(growth).getByText("25%")).toBeInTheDocument();
    expect(within(growth).getByText("min_pct = 25")).toBeInTheDocument();

    const newHigh = within(table).getByRole("rowheader", { name: "Near a new high" }).closest("tr")!;
    expect(within(newHigh).getByText("Core · Trigger")).toBeInTheDocument();
    expect(within(newHigh).getByText("max_off_pct = 15")).toBeInTheDocument();
    expect(within(newHigh).getByText("fraction = 0.8")).toBeInTheDocument();

    const leader = within(table).getByRole("rowheader", { name: "Market leader" }).closest("tr")!;
    expect(within(leader).getByText("Non-core")).toBeInTheDocument();
    expect(within(leader).getByText("0%")).toBeInTheDocument();
    expect(within(leader).getByText("No numeric parameter")).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/\bOff\b/);
  });

  it("takes each rule's role and weight from the live version, not from the catalogue", async () => {
    getStrategies.mockResolvedValue({
      strategies: [
        {
          ...canslim,
          rules: canslim.rules.map((rule) =>
            rule.id === "leader" ? { ...rule, core: true, weight: 0.5 } : rule,
          ),
        },
      ],
      regime: null,
    });
    render(await StrategyRulesPage({ params: Promise.resolve({ strategy: "canslim" }) }));
    const table = screen.getByRole("table");
    const leader = within(table).getByRole("rowheader", { name: "Market leader" }).closest("tr")!;
    expect(within(leader).getByText("Non-core")).toBeInTheDocument();
    expect(within(leader).getByText("0%")).toBeInTheDocument();
    expect(within(leader).queryByText("50%")).not.toBeInTheDocument();
  });

  it("bails and shows the unavailable card when the live version names no rule settings", async () => {
    getStrategyVersion.mockResolvedValue(version("canslim", HASH, { rules: [] }));
    render(await StrategyRulesPage({ params: Promise.resolve({ strategy: "canslim" }) }));
    expect(bailOnEmptyRender).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("names the version, its hash and its live date, and never repeats the author's rule wording", async () => {
    const { container } = render(
      await StrategyRulesPage({ params: Promise.resolve({ strategy: "canslim" }) }),
    );
    expect(screen.getByText("v0 · 3f9a1c2e · engine 1.0.0")).toBeInTheDocument();
    expect(screen.getByText(HASH)).toBeInTheDocument();
    expect(screen.getByText("3 November 2026")).toBeInTheDocument();
    expect(container.textContent).not.toContain(CANSLIM_RULE_TEXT);
    expect(container.textContent).not.toContain(CANSLIM_EVALUATION);
    expect(screen.queryByRole("button", { name: /edit a copy/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/edit a copy/i)).not.toBeInTheDocument();
  });

  it("lists the universe and data policy and only this strategy's changelog entries", async () => {
    render(await StrategyRulesPage({ params: Promise.resolve({ strategy: "canslim" }) }));
    expect(screen.getByText("Candidates are ordinary shares only.")).toBeInTheDocument();

    const changelog = screen.getByRole("region", { name: "Changelog" });
    const entries = within(changelog).getAllByRole("article");
    expect(entries).toHaveLength(2);
    expect(entries[0]).toHaveAttribute("id", OLD_HASH);
    expect(within(entries[0]!).getByText("Earlier wording.")).toBeInTheDocument();
    expect(within(entries[0]!).getByText(/superseded 3 November 2026/)).toBeInTheDocument();
    expect(entries[1]).toHaveAttribute("id", HASH);
    expect(within(entries[1]!).getByText("Live")).toBeInTheDocument();
    expect(within(entries[1]!).getByText("A recent issuer can read as unknown.")).toBeInTheDocument();
  });

  it("lists this strategy's versions newest first, with their live and superseded dates", async () => {
    render(await StrategyRulesPage({ params: Promise.resolve({ strategy: "canslim" }) }));
    const history = screen.getByRole("region", { name: "Version history" });
    const items = within(history).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent("Live now, from 3 November 2026");
    expect(items[1]).toHaveTextContent("Superseded on 3 November 2026");
    expect(within(items[1]!).getByRole("link", { name: "Changelog entry" })).toHaveAttribute(
      "href",
      `/strategies/changelog#${OLD_HASH}`,
    );
    expect(screen.queryByText(/other strategy/)).toBeNull();
  });

  it("says the version history is unavailable, and keeps the parameters, when the read fails", async () => {
    listStrategyVersions.mockResolvedValue(null);
    render(await StrategyRulesPage({ params: Promise.resolve({ strategy: "canslim" }) }));
    const history = screen.getByRole("region", { name: "Version history" });
    expect(within(history).getByText("The version history is unavailable right now.")).toBeInTheDocument();
  });

  it("says so and bails the cache lifetime when the live version cannot be read", async () => {
    getStrategyVersion.mockResolvedValue(null);
    render(await StrategyRulesPage({ params: Promise.resolve({ strategy: "canslim" }) }));
    expect(bailOnEmptyRender).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/temporarily unavailable/)).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("bails when the changelog read fails, and keeps the parameters", async () => {
    listStrategyVersions.mockResolvedValue(null);
    render(await StrategyRulesPage({ params: Promise.resolve({ strategy: "canslim" }) }));
    expect(bailOnEmptyRender).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.getByText(/changelog is unavailable right now/)).toBeInTheDocument();
  });
});
