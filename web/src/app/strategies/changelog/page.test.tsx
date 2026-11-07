import { render, screen, within } from "@testing-library/react";

import StrategyChangelogPage, { metadata } from "./page";
import type { StrategyVersionDetailView } from "~/@/lib/strategies/types";

const listStrategyVersionsMock = jest.fn();
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
}));
jest.mock("~/app/actions/config", () => ({
  bailOnEmptyRender: () => bailOnEmptyRender(),
}));
jest.mock("~/app/actions/strategies/listStrategyVersions", () => ({
  listStrategyVersions: () => listStrategyVersionsMock(),
}));

const HASH = "3f9a1c2e" + "0".repeat(56);

function v0(strategyId: string): StrategyVersionDetailView {
  return {
    version: {
      strategyId,
      label: "v0",
      rulesHash: HASH,
      engineVersion: "1.0.0",
      featureSet: "fs1",
      status: "live",
      liveFrom: "",
      kind: "canonical",
      variantId: "",
    },
    params: [],
    rules: [],
    policies: ["Candidates are every instrument with price history, exchange-traded products included."],
    changes: ["Initial version."],
    knownIssues: ["An ETF or a listed investment company can trigger."],
    supersededOn: "",
    retiredOn: "",
  };
}

describe("StrategyChangelogPage", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("is indexable ISR with a canonical URL and no robots override", () => {
    expect(metadata.alternates?.canonical).toMatch(/\/strategies\/changelog$/);
    expect(metadata.robots).toBeUndefined();
  });

  it("titles itself without the brand, which the root template appends", () => {
    expect(metadata.title).toBe("Strategy Rules Changelog");
    expect(metadata.openGraph?.title).toBe("Strategy Rules Changelog | Shorted");
  });

  it("lists each strategy's v0 with its hash, engine and known issues", async () => {
    listStrategyVersionsMock.mockResolvedValue([v0("zanger-breakout"), v0("canslim")]);
    render(await StrategyChangelogPage());

    expect(screen.getByRole("heading", { level: 1, name: "Strategy Rules Changelog" })).toBeInTheDocument();
    const zanger = screen.getByRole("region", { name: "Zanger Breakout Strategy" });
    expect(within(zanger).getByText(`rules_hash ${HASH}`)).toBeInTheDocument();
    expect(within(zanger).getByText("v0 · 3f9a1c2e · engine 1.0.0 · feature set fs1")).toBeInTheDocument();
    expect(within(zanger).getByText("Live")).toBeInTheDocument();
    expect(within(zanger).getByText("An ETF or a listed investment company can trigger.")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "CAN SLIM Strategy" })).toBeInTheDocument();
    // A version chip's #<rules_hash> link lands on its own entry.
    const entry = zanger.querySelector(`article[id="${HASH}"]`);
    expect(entry).not.toBeNull();
    // The sticky chrome (the site header and the workspace sub-nav) sits over the top
    // 124px, so the anchored card must scroll to clear it.
    expect(entry).toHaveClass("scroll-mt-[124px]");
    expect(bailOnEmptyRender).not.toHaveBeenCalled();
  });

  it("bails the render's cache lifetime and says so when the read fails", async () => {
    listStrategyVersionsMock.mockResolvedValue(null);
    render(await StrategyChangelogPage());

    expect(bailOnEmptyRender).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/changelog is unavailable right now/)).toBeInTheDocument();
  });
});
