/// <reference types="jest" />

import { render, screen, within } from "@testing-library/react";
import OwnershipConnectionsPage, { metadata, revalidate } from "./page";

const bailOnEmptyRender = jest.fn(async () => undefined);
const loadOwnershipFlows = jest.fn();
const ownershipFlowsProps = jest.fn();

jest.mock("~/@/components/layouts/dashboard-layout", () => ({
  DashboardLayout: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
jest.mock("~/app/actions/config", () => ({
  bailOnEmptyRender: () => bailOnEmptyRender(),
}));
jest.mock("~/app/actions/ownershipDesk", () => ({
  loadOwnershipFlows: (...args: unknown[]) => loadOwnershipFlows(...args),
  loadInspector: jest.fn(),
}));
jest.mock("~/@/components/ownership/desk/ownership-flows", () => ({
  OwnershipFlows: (props: unknown) => {
    ownershipFlowsProps(props);
    return <div data-testid="flows" />;
  },
}));
jest.mock("~/@/components/ownership/workspace/inspector", () => ({
  Inspector: () => <aside aria-label="Inspector" />,
}));

const FLOWS_OK = { ok: true, error: "", from: "", to: "", asOf: "2026-10-30", positions: [], changes: [] };

beforeEach(() => {
  jest.clearAllMocks();
  loadOwnershipFlows.mockResolvedValue(FLOWS_OK);
  void({ ok: true, error: "", snapshotDates: ["2026-09-01", "2026-10-30"], from: "", to: "", rows: [] });
});

describe("the connections page (spec 14.3)", () => {
  it("is static for an hour and carries the wireframe's title and lede", async () => {
    expect(revalidate).toBe(3600);
    render(await OwnershipConnectionsPage());
    expect(screen.getByRole("heading", { level: 1, name: "Follow the ownership connections" })).toBeInTheDocument();
    expect(screen.getByText("Disclosed interests by holder type and sector")).toBeInTheDocument();
  });

  it("draws the full sankey, handing it the flows loader and the connections' own link", async () => {
    render(await OwnershipConnectionsPage());
    expect(screen.getByTestId("flows")).toBeInTheDocument();
    const props = ownershipFlowsProps.mock.calls[0]?.[0] as { variant?: string; basePath?: string; loadFlows?: unknown };
    expect(props.variant).toBe("full");
    expect(props.basePath).toBe("/ownership/connections");
    expect(typeof props.loadFlows).toBe("function");
  });

  it("bails the cache, and draws no sankey, when the flows cannot be read", async () => {
    loadOwnershipFlows.mockResolvedValue({ ...FLOWS_OK, ok: false });
    render(await OwnershipConnectionsPage());
    expect(bailOnEmptyRender).toHaveBeenCalled();
  });

  it("has a canonical URL of its own", () => {
    expect(metadata.alternates).toEqual({ canonical: "https://shorted.com.au/ownership/connections" });
  });

  it("ends the main column with the closed method disclosure, its text in the HTML", async () => {
    const { container } = render(await OwnershipConnectionsPage());
    const method = container.querySelector("details#method") as HTMLElement | null;
    expect(method).not.toBeNull();
    expect(method).not.toHaveAttribute("open");
    expect(within(method as HTMLElement).getByText("How these figures are read")).toBeInTheDocument();
    expect(method?.textContent).toMatch(/what the notices disclose, not a share of the company/);
    expect(method?.nextElementSibling).toBeNull();
  });
});
