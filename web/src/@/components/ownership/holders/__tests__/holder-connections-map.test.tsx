/// <reference types="jest" />

import { fireEvent, render, screen } from "@testing-library/react";
import { HolderConnectionsMap } from "../holder-connections-map";
import {
  SECTOR_SHOWN,
  connectionsPage,
  holderRowFrom,
  type HolderConnectionsPage,
  type RawPosition,
} from "../holder-tree";

let mockSearch = "";
const mockReplace = jest.fn();
jest.mock("next/navigation", () => ({
  usePathname: () => "/ownership/holders",
  useRouter: () => ({ prefetch: jest.fn(), replace: mockReplace }),
  useSearchParams: () => new URLSearchParams(mockSearch),
}));

const raw = (code: string, industry: string, vp: number): RawPosition => ({
  stockCode: code,
  companyName: `${code} Limited`,
  industry,
  votingPowerPct: vp,
  eventDate: "2026-10-14",
  announcementUrl: `https://www.asx.com.au/${code}.pdf`,
});

const holder = holderRowFrom({
  slug: "vanguard",
  name: "Vanguard",
  kind: "index_manager",
  website: "",
  substantialPositions: 3,
  latestNoticeDate: "2026-11-02",
});

const caps = new Map<string, number | null>([
  ["BHP", 200e9],
  ["CBA", 150e9],
  ["NEW", null],
]);

const page = connectionsPage(
  holder,
  [raw("BHP", "Materials", 6), raw("CBA", "Banks", 5), raw("NEW", "Materials", 4)],
  caps,
);

const loadConnections = jest.fn(async (): Promise<HolderConnectionsPage> => page);

function renderMap(initial: HolderConnectionsPage = page) {
  return render(
    <HolderConnectionsMap defaultKey="vanguard" initial={initial} loadConnections={loadConnections} />,
  );
}

describe("holder connections map (spec 14.3)", () => {
  beforeEach(() => {
    mockSearch = "";
    mockReplace.mockClear();
    loadConnections.mockClear();
  });

  it("draws the holder's name, its sectors and its companies, with the wireframe's copy", () => {
    renderMap();
    expect(screen.getByRole("heading", { name: "Vanguard’s disclosed connections" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Materials/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Banks/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /BHP/ })).toBeInTheDocument();
    expect(screen.getByText("Width: estimated disclosed exposure")).toBeInTheDocument();
    expect(screen.getByText("Based on reported voting power and market value")).toBeInTheDocument();
  });

  it("selects a company into the URL, and a sector as a connection of the holder's kind", () => {
    renderMap();
    fireEvent.click(screen.getByRole("button", { name: /BHP/ }));
    expect(mockReplace).toHaveBeenLastCalledWith("/ownership/holders?sel=stock%3ABHP", { scroll: false });
    fireEvent.click(screen.getByRole("button", { name: /Materials/ }));
    const written = String(mockReplace.mock.calls.at(-1)?.[0]);
    expect(decodeURIComponent(written)).toBe("/ownership/holders?sel=connection:index_manager>Materials");
  });

  it("marks the selected company pressed and offers Clear selection, which removes it", () => {
    mockSearch = "sel=stock%3ABHP";
    renderMap();
    expect(screen.getByRole("button", { name: /BHP/ })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "Clear selection" }));
    expect(mockReplace).toHaveBeenLastCalledWith("/ownership/holders", { scroll: false });
  });

  it("says a holder with no positions has nothing to show, and says a failed read is this end's failure", () => {
    const empty = connectionsPage(holder, [], null);
    const { unmount } = renderMap(empty);
    expect(screen.getByText("Vanguard has no current disclosed connection to draw.")).toBeInTheDocument();
    unmount();
    renderMap({ ok: false, error: "", holder: null, positions: [], capsOk: false });
    expect(screen.getByText(/this is our end/)).toBeInTheDocument();
  });

  it("folds companies beyond six per sector, and Expand other companies opens them", () => {
    const many = Array.from({ length: SECTOR_SHOWN + 2 }, (_, i) =>
      raw(`M${String(i).padStart(2, "0")}`, "Materials", 5 - i * 0.1),
    );
    renderMap(connectionsPage(holder, many, new Map(many.map((m) => [m.stockCode, 1e9]))));
    const folded = screen.getByRole("button", { name: "Other companies (2)" });
    expect(folded).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Expand other companies +" }));
    expect(screen.queryByRole("button", { name: "Other companies (2)" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Collapse other companies −" })).toBeInTheDocument();
  });

  it("lights a company folded under Other companies, with its row and its sector", () => {
    const many = Array.from({ length: SECTOR_SHOWN + 2 }, (_, i) =>
      raw(`M${String(i).padStart(2, "0")}`, "Materials", 5 - i * 0.1),
    );
    mockSearch = "sel=stock%3AM07";
    renderMap(connectionsPage(holder, many, new Map(many.map((m) => [m.stockCode, 1e9]))));
    expect(screen.getByRole("button", { name: "Other companies (2)" })).toHaveClass("bg-primary/15");
    expect(screen.getByRole("button", { name: /Materials/ })).toHaveAttribute("aria-pressed", "true");
  });

  it("notes that market caps are missing, and keeps its figures in a table for a reader who cannot see the map", () => {
    renderMap(connectionsPage(holder, [raw("NEW", "Materials", 4)], null));
    expect(screen.getByText(/every width is a hairline/)).toBeInTheDocument();
    const table = screen.getByRole("table", { name: "Vanguard's disclosed connections, sector by sector" });
    expect(table).toHaveTextContent("NEW");
    expect(table).toHaveTextContent("n/a");
  });

  it("reads another holder's connections when the URL names one, and only once", async () => {
    mockSearch = "holder=regal";
    loadConnections.mockResolvedValueOnce(
      connectionsPage(holderRowFrom({ slug: "regal", name: "Regal Partners", kind: "active_manager", website: "", substantialPositions: 1, latestNoticeDate: "" }), [raw("WES", "Consumer Services", 6)], new Map([["WES", 1e9]])),
    );
    renderMap();
    expect(await screen.findByRole("heading", { name: "Regal Partners’s disclosed connections" })).toBeInTheDocument();
    expect(loadConnections).toHaveBeenCalledTimes(1);
    expect(loadConnections).toHaveBeenCalledWith("regal");
  });
});
