import { act, render, screen } from "@testing-library/react";

import { insightsPage } from "~/@/lib/ownership/insights/__tests__/fixtures";
import { emptyInsightsPage } from "~/@/lib/ownership/insights/types";

import InsightsPageRoute, { metadata, revalidate } from "./page";

const loadOwnershipInsights = jest.fn();
const bailOnEmptyRender = jest.fn();

jest.mock("~/@/components/layouts/dashboard-layout", () => ({
  DashboardLayout: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
jest.mock("@/components/seo/llm-meta", () => ({
  LLMMeta: () => null,
}));
jest.mock("~/app/actions/config", () => ({
  bailOnEmptyRender: () => bailOnEmptyRender(),
}));
jest.mock("~/app/actions/ownershipInsights", () => ({
  loadOwnershipInsights: (...args: unknown[]) => loadOwnershipInsights(...args),
}));
// The charts arrive after the page; the server HTML holds their tables.
jest.mock("~/@/components/ownership/insights/insights-charts-lazy", () => ({
  MarketMapLazy: () => <div data-testid="chart" />,
  MoneyFlowLazy: () => <div data-testid="chart" />,
  PositionHeatmapLazy: () => <div data-testid="chart" />,
}));
jest.mock("next/navigation", () => ({
  useSearchParams: () => {
    throw new Promise<never>(() => undefined);
  },
}));

beforeEach(() => {
  jest.clearAllMocks();
  loadOwnershipInsights.mockResolvedValue(insightsPage());
});

describe("/ownership/insights", () => {
  it("is ISR with its own canonical, and asks for the default view only", async () => {
    expect(revalidate).toBe(3600);
    expect(metadata.alternates?.canonical).toBe("https://shorted.com.au/ownership/insights");
    render(await InsightsPageRoute());
    expect(loadOwnershipInsights).toHaveBeenCalledWith({});
    expect(bailOnEmptyRender).not.toHaveBeenCalled();
  });

  it("renders the desk, every view's heading and its table, then the method, the disclaimer and Report an error", async () => {
    const { container } = render(await InsightsPageRoute());
    await act(async () => {});
    expect(screen.getByRole("heading", { level: 1, name: "Ownership insights" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Most crowded sectors" })).toBeInTheDocument();
    for (const name of ["Market map", "Position changes", "Money flow", "Sources and method"]) {
      expect(screen.getByRole("heading", { name })).toBeInTheDocument();
    }
    expect(screen.getByText("The market map as a table: every sector")).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: "Not financial advice" }).length).toBeGreaterThan(0);
    expect(screen.getByRole("link", { name: "Report an error" }).getAttribute("href")).toMatch(/subject=Ownership%20data%3A%20insights/);
    const text = container.textContent ?? "";
    expect(text).toMatch(/Window 2026-08-03 to 2026-10-31/);
    expect(text).toMatch(/what the notices disclose, not a share of the company/);
    expect(text).not.toMatch(/—|\bsold\b|\bsale\b|index ETF/i);
  });

  it("bails a shell when the read did not answer, and draws no desk", async () => {
    loadOwnershipInsights.mockResolvedValue(emptyInsightsPage({ from: "", to: "", sector: null, stock: "" }, "all"));
    const { container } = render(await InsightsPageRoute());
    expect(bailOnEmptyRender).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-isr-shell="empty"]')).not.toBeNull();
    expect(screen.queryByRole("heading", { name: "Most crowded sectors" })).toBeNull();
  });
});
