/// <reference types="jest" />

import { render, screen, within } from "@testing-library/react";
import OwnershipActivityPage, { metadata, revalidate } from "./page";

const bailOnEmptyRender = jest.fn(async () => undefined);
const loadOwnershipActivity = jest.fn();
const movementProps = jest.fn();
const inspectorProps = jest.fn();

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
  Inspector: (props: unknown) => {
    inspectorProps(props);
    return <aside aria-label="Inspector" />;
  },
}));

const ACTIVITY_OK = {
  ok: true,
  error: "",
  fromWeek: "2025-11-03",
  toWeek: "2026-10-26",
  asOf: "2026-10-30",
  rows: [],
  largestMoves: [
    {
      released: "2026-10-28",
      code: "BHP",
      holder: "Vanguard",
      url: "https://www.asx.com.au/asxpdf/20261028/pdf/bhp.pdf",
      change: 1.2,
    },
    {
      released: "2026-10-20",
      code: "RIO",
      holder: "BlackRock",
      url: "javascript:alert(1)",
      change: -2.5,
    },
  ],
};

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

  it("hands the inspector the window's largest moves, each with its change, date and safe notice link", async () => {
    render(await OwnershipActivityPage());
    const props = inspectorProps.mock.calls[0]?.[0] as { largestMoves?: { windowDays: number; from: string; to: string; lines: { label: string; value: string; href: string }[] } | null };
    expect(props.largestMoves?.windowDays).toBe(362);
    expect(props.largestMoves?.from).toBe("2025-11-03");
    expect(props.largestMoves?.to).toBe("2026-10-30");
    expect(props.largestMoves?.lines).toEqual([
      { label: "BHP · Vanguard", value: "+1.20 pp · 2026-10-28", href: "https://www.asx.com.au/asxpdf/20261028/pdf/bhp.pdf" },
      { label: "RIO · BlackRock", value: "−2.50 pp · 2026-10-20", href: "" },
    ]);
  });

  it("draws no largest moves when the activity did not answer, rather than an empty list", async () => {
    loadOwnershipActivity.mockResolvedValue({ ...ACTIVITY_OK, ok: false });
    render(await OwnershipActivityPage());
    const props = inspectorProps.mock.calls[0]?.[0] as { largestMoves?: unknown };
    expect(props.largestMoves).toBeNull();
  });

  it("is a shell when the activity did not answer, so the sweep re-primes the page", async () => {
    loadOwnershipActivity.mockResolvedValue({ ...ACTIVITY_OK, ok: false });
    const { container } = render(await OwnershipActivityPage());
    expect(container.querySelector("[data-isr-shell='empty']")).not.toBeNull();
  });

  it("is not a shell when both reads answer", async () => {
    const { container } = render(await OwnershipActivityPage());
    expect(container.querySelector("[data-isr-shell='empty']")).toBeNull();
  });

  it("ends the main column with the closed method disclosure, its text in the HTML", async () => {
    const { container } = render(await OwnershipActivityPage());
    const method = container.querySelector("details#method") as HTMLElement | null;
    expect(method).not.toBeNull();
    expect(method).not.toHaveAttribute("open");
    expect(within(method as HTMLElement).getByText("How these figures are read")).toBeInTheDocument();
    expect(method?.textContent).toMatch(/what the notices disclose, not a share of the company/);
    expect(method?.nextElementSibling).toBeNull();
  });
});
