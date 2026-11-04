/// <reference types="jest" />

import { render, screen } from "@testing-library/react";
import OwnershipActivityPage, { metadata, revalidate } from "./page";

const bailOnEmptyRender = jest.fn(async () => undefined);
const loadOwnershipActivity = jest.fn();
const movementProps = jest.fn();

jest.mock("~/@/components/layouts/dashboard-layout", () => ({
  DashboardLayout: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
jest.mock("~/app/actions/config", () => ({
  bailOnEmptyRender: () => bailOnEmptyRender(),
}));
jest.mock("~/app/actions/ownershipDesk", () => ({
  loadOwnershipActivity: (...args: unknown[]) => loadOwnershipActivity(...args),
  loadInspector: jest.fn(),
}));
jest.mock("~/@/components/ownership/desk/movement-heatmap", () => ({
  MovementHeatmap: (props: unknown) => {
    movementProps(props);
    return <div data-testid="movement" />;
  },
}));
jest.mock("~/@/components/ownership/workspace/inspector", () => ({
  Inspector: () => <aside aria-label="Inspector" />,
}));

const ACTIVITY_OK = { ok: true, error: "", fromWeek: "2025-11-03", toWeek: "2026-10-26", asOf: "2026-10-30", rows: [] };

beforeEach(() => {
  jest.clearAllMocks();
  loadOwnershipActivity.mockResolvedValue(ACTIVITY_OK);
});

describe("the activity page (spec 14.3)", () => {
  it("is static for an hour and carries the wireframe's title and lede", async () => {
    expect(revalidate).toBe(3600);
    render(await OwnershipActivityPage());
    expect(screen.getByRole("heading", { level: 1, name: "Where ownership activity is changing" })).toBeInTheDocument();
    expect(screen.getByText("Explore notices across sectors and time")).toBeInTheDocument();
  });

  it("draws the full movement grid, handing it the activity loader so its holder type can ask again", async () => {
    render(await OwnershipActivityPage());
    expect(screen.getByTestId("movement")).toBeInTheDocument();
    const props = movementProps.mock.calls[0]?.[0] as { variant?: string; loadActivity?: unknown; basePath?: string };
    expect(props.variant).toBe("full");
    expect(typeof props.loadActivity).toBe("function");
    expect(props.basePath).toBe("/ownership/activity");
  });

  it("bails the cache when the movement cannot be read", async () => {
    loadOwnershipActivity.mockResolvedValue({ ...ACTIVITY_OK, ok: false });
    render(await OwnershipActivityPage());
    expect(bailOnEmptyRender).toHaveBeenCalled();
  });

  it("has a canonical URL of its own", () => {
    expect(metadata.alternates).toEqual({ canonical: "https://shorted.com.au/ownership/activity" });
  });
});
