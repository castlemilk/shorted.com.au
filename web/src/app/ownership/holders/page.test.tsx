/// <reference types="jest" />

import { render, screen, within } from "@testing-library/react";
import type { HolderConnectionsPage, HolderRow, HoldersDirectoryPage } from "~/@/components/ownership/holders/holder-tree";
import { bailOnEmptyRender } from "~/app/actions/config";
import { loadHolderConnections, loadHolders, resolveHolderInspector } from "~/app/actions/ownershipHolders";
import HoldersPage, { metadata, revalidate } from "./page";

jest.mock("~/@/components/gamma/SearchCombobox", () => ({
  SearchCombobox: ({ options, onValueChange, placeholder, ...rest }: {
    options: Array<{ value: string; label: string }>;
    onValueChange?: (value: string | null) => void;
    placeholder?: string;
    "aria-label"?: string;
  }) => (
    <select aria-label={rest["aria-label"]} defaultValue="" onChange={(e) => onValueChange?.(e.target.value || null)}>
      <option value="">{placeholder}</option>
      {options.map((o) => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </select>
  ),
}));
jest.mock("~/@/components/layouts/dashboard-layout", () => ({
  DashboardLayout: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
jest.mock("~/app/actions/config", () => ({
  bailOnEmptyRender: jest.fn(async () => undefined),
}));
jest.mock("~/app/actions/ownershipHolders", () => ({
  loadHolders: jest.fn(),
  loadHolderConnections: jest.fn(),
  resolveHolderInspector: jest.fn(),
}));

const holder = (key: string, name: string, kind: string, positions: number): HolderRow => ({
  key,
  name,
  kind,
  website: "",
  positions,
  latestNoticeDate: "2026-11-02",
});

const directory: HoldersDirectoryPage = {
  ok: true,
  error: "",
  holders: [holder("vanguard", "Vanguard", "index_manager", 157), holder("aus-super", "AustralianSuper", "super_fund", 60)],
  total: 2,
};

const connections: HolderConnectionsPage = {
  ok: true,
  error: "",
  holder: holder("vanguard", "Vanguard", "index_manager", 157),
  positions: [
    {
      stockCode: "BHP",
      companyName: "BHP Group",
      industry: "Materials",
      votingPowerPct: 6,
      eventDate: "2026-10-14",
      announcementUrl: "https://www.asx.com.au/bhp.pdf",
      marketCap: 200e9,
    },
  ],
  capsOk: true,
};

describe("holders page (spec 14.3)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(loadHolders).mockResolvedValue(directory);
    jest.mocked(loadHolderConnections).mockResolvedValue(connections);
    jest.mocked(resolveHolderInspector).mockResolvedValue(null);
  });

  it("is static ISR with its own metadata, and reads no search params", () => {
    expect(revalidate).toBe(3600);
    expect(metadata.alternates).toEqual({ canonical: "https://shorted.com.au/ownership/holders" });
  });

  it("draws the heading, the directory and the default holder's connections", async () => {
    render(await HoldersPage());
    expect(screen.getByRole("heading", { level: 1, name: "Who holds the market?" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Vanguard’s disclosed connections" })).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Holders" })).toBeInTheDocument();
    expect(loadHolderConnections).toHaveBeenCalledWith("vanguard");
    expect(bailOnEmptyRender).not.toHaveBeenCalled();
  });

  it("bails out of the render when the directory did not answer, so the shell is not cached", async () => {
    jest.mocked(loadHolders).mockResolvedValue({ ok: false, error: "", holders: [], total: 0 });
    jest.mocked(loadHolderConnections).mockResolvedValue({ ok: false, error: "", holder: null, positions: [], capsOk: false });
    const { container } = render(await HoldersPage());
    expect(bailOnEmptyRender).toHaveBeenCalled();
    expect(container.querySelector('[data-isr-shell="empty"]')).not.toBeNull();
  });

  it("draws the lede in the wireframe's words, people included", async () => {
    const { container } = render(await HoldersPage());
    expect(
      screen.getByText("Explore institutions, organisations and people through their disclosed interests."),
    ).toBeInTheDocument();
    expect(container.querySelector('[data-isr-shell="empty"]')).toBeNull();
  });
  it("bails out of the render when the market caps did not load, so the hairline map is not cached", async () => {
    jest.mocked(loadHolderConnections).mockResolvedValue({ ...connections, capsOk: false });
    render(await HoldersPage());
    expect(bailOnEmptyRender).toHaveBeenCalled();
    expect(screen.getByText(/Market caps could not be read just now/)).toBeInTheDocument();
  });

  it("reads no holder, and bails, when the directory is empty", async () => {
    jest.mocked(loadHolders).mockResolvedValue({ ok: true, error: "", holders: [], total: 0 });
    const { container } = render(await HoldersPage());
    expect(loadHolderConnections).not.toHaveBeenCalled();
    expect(bailOnEmptyRender).toHaveBeenCalled();
    expect(container.querySelector('[data-isr-shell="empty"]')).not.toBeNull();
  });

  it("draws the default holder's notices-by-week strip in its inspector when the notices read", async () => {
    jest.mocked(loadHolderConnections).mockResolvedValue({
      ...connections,
      weekNotices: { asOf: "2026-11-02", released: ["2026-10-20"] },
    });
    render(await HoldersPage());
    expect(screen.getByRole("group", { name: "Notices by week" })).toBeInTheDocument();
  });

  it("draws no notices-by-week strip when the notices did not read", async () => {
    jest.mocked(loadHolderConnections).mockResolvedValue({ ...connections, weekNotices: null });
    render(await HoldersPage());
    expect(screen.queryByRole("group", { name: "Notices by week" })).toBeNull();
  });

  it("ends the main column with the closed method disclosure, its text in the HTML", async () => {
    const { container } = render(await HoldersPage());
    const method = container.querySelector("details#method") as HTMLElement | null;
    expect(method).not.toBeNull();
    expect(method).not.toHaveAttribute("open");
    expect(within(method as HTMLElement).getByText("How these figures are read")).toBeInTheDocument();
    expect(method?.textContent).toMatch(/what the notices disclose, not a share of the company/);
    expect(method?.nextElementSibling).toBeNull();
  });
});
