/// <reference types="jest" />

/**
 * The flows (spec 13.3): the positions and the window's changes as a sankey, each
 * band and node a link with its figures in a title, the same links in the sr-only
 * table, and a window that reloads the instrument without emptying it.
 */

import { act, fireEvent, render, screen, within } from "@testing-library/react";

import type { DeskRangeInput, OwnershipFlowsPage } from "~/app/actions/ownershipDesk";
import { OwnershipFlows } from "../ownership-flows";
import {
  FLOWS_LOADING,
  FLOWS_OUTAGE,
  FLOW_POSITIONS_CAPTION,
  FLOW_SIZES,
  OwnershipFlowsStatic,
  bandFillOpacity,
  changeBandTitle,
  connectionIsSelected,
  flowLayout,
  flowRegisterHref,
  kindColour,
  positionBandTitle,
} from "../ownership-flows-static";
import { LABEL_GAP, labelWidth } from "../flows-layout";
import { DESK_DEFAULT_WINDOW_STATE } from "../window-chips";

let mockSearchParams = new URLSearchParams("");
jest.mock("next/navigation", () => ({
  useSearchParams: () => mockSearchParams,
  useRouter: () => ({ replace: jest.fn(), push: jest.fn(), prefetch: jest.fn() }),
}));

const PAGE: OwnershipFlowsPage = {
  ok: true,
  error: "",
  from: "2026-08-06",
  to: "2026-11-03",
  asOf: "2026-11-03",
  positions: [
    { kind: "super_fund", industry: "Materials", exposureAud: 3_000_000_000, holdings: 4, largestCode: "BHP", largestPct: 9.2 },
    { kind: "hedge_fund", industry: "Materials", exposureAud: 500_000_000, holdings: 1, largestCode: "FMG", largestPct: 5.4 },
    { kind: "bank_broker", industry: "Financials", exposureAud: null, holdings: 3, largestCode: "MQG", largestPct: 7.7 },
  ],
  changes: [
    { kind: "super_fund", industry: "Materials", direction: "up", exposureAud: 400_000_000, notices: 3 },
    { kind: "super_fund", industry: "Materials", direction: "down", exposureAud: 150_000_000, notices: 1 },
  ],
};

const EMPTY_PAGE: OwnershipFlowsPage = {
  ok: true,
  error: "",
  from: "",
  to: "",
  asOf: "",
  positions: [],
  changes: [],
};

const TABLE_POSITIONS = "Disclosed exposure by holder kind and industry";
const TABLE_CHANGES = "Change in disclosed exposure by holder kind and industry";

beforeEach(() => {
  mockSearchParams = new URLSearchParams("");
});

describe("the figures a band and a node state", () => {
  it("states a position's exposure, holdings and largest holding, in prose", () => {
    expect(
      positionBandTitle({
        kind: "super_fund",
        industry: "Materials",
        exposureAud: 3_000_000_000,
        holdings: 4,
        largestCode: "BHP",
        largestPct: 9.2,
      }),
    ).toBe(
      "Super fund in Materials: A$3.0B disclosed exposure, estimated, across 4 holdings; largest BHP at 9.20%",
    );
  });

  it("states a change by its direction, with the notices behind it", () => {
    expect(
      changeBandTitle({ kind: "super_fund", industry: "Materials", direction: "down", exposureAud: 150_000_000, notices: 1 }),
    ).toBe("Super fund, decreases in Materials: A$150.0M change in disclosed exposure, estimated, across 1 notice");
  });

  it("says n/a for an exposure no interest can be estimated from", () => {
    expect(
      positionBandTitle({
        kind: "bank_broker",
        industry: "Financials",
        exposureAud: null,
        holdings: 3,
        largestCode: "",
        largestPct: null,
      }),
    ).toContain("n/a disclosed exposure");
  });

  it("links a band to the registers filtered to its kind and industry, and leaves the industry out for the placeholder group", () => {
    expect(flowRegisterHref("super_fund", "Materials")).toBe("/ownership/stocks?industry=Materials&kind=super_fund");
    expect(flowRegisterHref("super_fund", "Other")).toBe("/ownership/stocks?kind=super_fund");
  });

  it("colours a kind with its category swatch, and the remainder in muted ink", () => {
    expect(kindColour("super_fund")).toBe("#87A96B");
    expect(kindColour("unclassified")).toBe("hsl(var(--muted-foreground))");
  });
});

/**
 * Every kind and eight sectors, the two longest names among them. Each kind has the same
 * exposure, so the holder nodes are the same height and the phone draws every label; the
 * sectors are weighted, so the fold keeps six and draws "Other sectors".
 */
const LONG_SECTORS = [
  "Commercial & Professional Services",
  "Consumer Discretionary Distribution & Retail",
  "Materials",
  "Banks",
  "Energy",
  "Health Care Equipment & Services",
  "Utilities",
  "Insurance",
];
const ALL_KINDS = [
  "super_fund",
  "index_manager",
  "active_manager",
  "hedge_fund",
  "bank_broker",
  "sovereign_public",
  "insurer",
  "private_equity",
  "corporate",
  "other",
  "unclassified",
];
const LABEL_PAGE: OwnershipFlowsPage = {
  ...PAGE,
  positions: ALL_KINDS.flatMap((kind) =>
    LONG_SECTORS.map((industry, index) => ({
      kind,
      industry,
      exposureAud: (LONG_SECTORS.length - index) * 1e8,
      holdings: 1,
      largestCode: "BHP",
      largestPct: 5,
    })),
  ),
  changes: [],
};

/** The two drawings the static view draws, by their viewBox. */
function drawings(container: HTMLElement) {
  const svgs = Array.from(container.querySelectorAll<SVGSVGElement>('svg[aria-hidden="true"]'));
  const phone = svgs.find((svg) => svg.getAttribute("viewBox") === `0 0 ${FLOW_SIZES.phone.width} ${FLOW_SIZES.phone.height}`);
  const full = svgs.find((svg) => svg.getAttribute("viewBox") === `0 0 ${FLOW_SIZES.full.width} ${FLOW_SIZES.full.height}`);
  if (!phone || !full) throw new Error("both drawings render");
  return { phone, full };
}

function labelled(svg: SVGSVGElement, text: string): SVGTextElement | undefined {
  return Array.from(svg.querySelectorAll<SVGTextElement>("text")).find((t) => t.textContent === text);
}

describe("the drawn labels (spec B6)", () => {
  it("draws every kind and every sector by its short name, at both sizes, and cuts none", () => {
    const { container } = render(<OwnershipFlowsStatic page={LABEL_PAGE} state={DESK_DEFAULT_WINDOW_STATE} basePath="/ownership" />);
    const { phone, full } = drawings(container);
    const expected = [
      "Super", "Index", "Active", "Hedge", "Bank/broker", "Sovereign", "Insurer", "PE", "Listed co", "Other", "Unclassified",
      "Professional services", "Discretionary retail", "Materials", "Banks", "Energy", "Health care", "Other sectors",
    ];
    for (const svg of [phone, full]) {
      const labels = Array.from(svg.querySelectorAll("text")).map((t) => t.textContent ?? "");
      for (const name of expected) expect(labels).toContain(name);
      for (const label of labels) expect(label).not.toContain("…");
    }
  });

  it("wraps a long sector label on the phone into two tspans, and draws it whole on the desktop", () => {
    const { container } = render(<OwnershipFlowsStatic page={LABEL_PAGE} state={DESK_DEFAULT_WINDOW_STATE} basePath="/ownership" />);
    const { phone, full } = drawings(container);
    const wrapped = labelled(phone, "Professional services");
    expect(wrapped).toBeDefined();
    expect(Array.from(wrapped!.querySelectorAll("tspan")).map((t) => t.textContent?.trim())).toEqual([
      "Professional",
      "services",
    ]);
    expect(Array.from(labelled(phone, "Discretionary retail")!.querySelectorAll("tspan")).map((t) => t.textContent?.trim())).toEqual([
      "Discretionary",
      "retail",
    ]);
    expect(labelled(full, "Professional services")!.querySelectorAll("tspan")).toHaveLength(1);
  });

  it("widens the desktop's right gutter to hold the longest sector name, and the phone's only to its wrapped width", () => {
    const desktop = flowLayout(LABEL_PAGE, "positions", FLOW_SIZES.full);
    expect(desktop.right).toBeGreaterThanOrEqual(labelWidth("Professional services", FLOW_SIZES.full.font) + LABEL_GAP);
    expect(desktop.width).toBe(FLOW_SIZES.full.width - desktop.left - desktop.right);
    const phone = flowLayout(LABEL_PAGE, "positions", FLOW_SIZES.phone);
    expect(phone.right).toBe(FLOW_SIZES.phone.right);
  });

  it("prints no label on the phone for a node too short to hold it, and keeps the node's title", () => {
    const page: OwnershipFlowsPage = {
      ...LABEL_PAGE,
      positions: LABEL_PAGE.positions.map((row) => (row.kind === "insurer" ? { ...row, exposureAud: 1e5 } : row)),
    };
    const { container } = render(<OwnershipFlowsStatic page={page} state={DESK_DEFAULT_WINDOW_STATE} basePath="/ownership" />);
    const { phone, full } = drawings(container);
    expect(labelled(phone, "Insurer")).toBeUndefined();
    expect(labelled(full, "Insurer")).toBeDefined();
    const node = Array.from(phone.querySelectorAll("rect")).find((r) => r.querySelector("title")?.textContent?.startsWith("Insurer:"));
    expect(node).toBeDefined();
  });

  it("draws the unclassified node in muted ink and its bands at 60 percent of the normal opacity", () => {
    const { container } = render(<OwnershipFlowsStatic page={LABEL_PAGE} state={DESK_DEFAULT_WINDOW_STATE} basePath="/ownership" />);
    const { full } = drawings(container);
    const node = Array.from(full.querySelectorAll("rect")).find((r) => r.querySelector("title")?.textContent?.startsWith("Unclassified:"));
    expect(node).toBeDefined();
    expect(node!.getAttribute("class")).toContain("fill-muted-foreground");
    expect(node!.getAttribute("fill")).toBe("hsl(var(--muted-foreground))");
    const label = labelled(full, "Unclassified");
    expect(label!.getAttribute("class")).toContain("text-muted-foreground");
    const remainderBand = full.querySelector('a[aria-label^="Unclassified in"] path');
    const ordinaryBand = full.querySelector('a[aria-label^="Super fund in"] path');
    expect(Number(remainderBand!.getAttribute("fill-opacity"))).toBeCloseTo(0.15 * 0.6, 6);
    expect(Number(ordinaryBand!.getAttribute("fill-opacity"))).toBeCloseTo(0.15, 6);
  });

  it("keeps the selected band's lift over the unselected ones, for the remainder as for the rest", () => {
    expect(bandFillOpacity(false, "super_fund")).toBeCloseTo(0.15, 6);
    expect(bandFillOpacity(true, "super_fund")).toBeCloseTo(0.8, 6);
    expect(bandFillOpacity(false, "unclassified")).toBeCloseTo(0.09, 6);
    expect(bandFillOpacity(true, "unclassified")).toBeCloseTo(0.48, 6);
    expect(bandFillOpacity(true, "unclassified")).toBeGreaterThan(bandFillOpacity(false, "unclassified"));
  });
});

describe("OwnershipFlowsStatic", () => {
  it("draws the positions with the caption the spec gives, and the mode row disabled on the server", () => {
    render(<OwnershipFlowsStatic page={PAGE} state={DESK_DEFAULT_WINDOW_STATE} basePath="/ownership" />);
    expect(screen.getByText(FLOW_POSITIONS_CAPTION)).toBeInTheDocument();
    const modes = screen.getByRole("group", { name: "What the bands show" });
    expect(within(modes).getByRole("button", { name: "Positions" })).toBeDisabled();
    expect(within(modes).getByRole("button", { name: "Positions" })).toHaveAttribute("aria-pressed", "true");
    // The window is one labelled select with four options, drawn disabled on the server (spec 14.9).
    const window = screen.getByRole("combobox", { name: "Window" });
    expect(window).toBeDisabled();
    expect(within(window).getAllByRole("option")).toHaveLength(4);
    expect(screen.queryByRole("group", { name: "Window of change" })).toBeNull();
  });

  it("groups a placeholder industry under Other in the table, with the same zoom and register links as the drawing", () => {
    const page: OwnershipFlowsPage = {
      ...PAGE,
      positions: [
        { kind: "super_fund", industry: "Not applicable", exposureAud: 100_000_000, holdings: 1, largestCode: "", largestPct: null },
      ],
    };
    render(<OwnershipFlowsStatic page={page} state={DESK_DEFAULT_WINDOW_STATE} basePath="/ownership" />);
    const table = screen.getByRole("table", { name: TABLE_POSITIONS });
    expect(within(table).queryByRole("link", { name: "Not applicable" })).toBeNull();
    expect(within(table).getByRole("link", { name: "Other" })).toHaveAttribute("href", "/ownership/map?sector=Other");
    expect(within(table).getByRole("link", { name: "A$100.0M" })).toHaveAttribute(
      "href",
      "/ownership/stocks?kind=super_fund",
    );
  });

  it("names every band in a title, and carries the same links in the sr-only table", () => {
    const { container } = render(
      <OwnershipFlowsStatic page={PAGE} state={DESK_DEFAULT_WINDOW_STATE} basePath="/ownership" />,
    );
    const titles = Array.from(container.querySelectorAll("title")).map((t) => t.textContent);
    expect(titles).toContain(
      "Super fund in Materials: A$3.0B disclosed exposure, estimated, across 4 holdings; largest BHP at 9.20%. Inspect underlying notices →",
    );

    const table = screen.getByRole("table", { name: TABLE_POSITIONS });
    expect(within(table).getAllByRole("row")).toHaveLength(4);
    expect(within(table).getByRole("link", { name: "Super fund" })).toHaveAttribute("href", "/ownership#directory-super_fund");
    expect(within(table).getByRole("link", { name: "A$3.0B" })).toHaveAttribute(
      "href",
      "/ownership/stocks?industry=Materials&kind=super_fund",
    );
    // A sector zoom is a link that keeps the reader's window and writes the sector.
    expect(within(table).getAllByRole("link", { name: "Materials" })[0]).toHaveAttribute(
      "href",
      "/ownership/map?sector=Materials",
    );
    expect(within(table).getByRole("cell", { name: "n/a" })).toBeInTheDocument();
  });

  it("says the flows could not be read, and draws nothing, when the read failed", () => {
    render(
      <OwnershipFlowsStatic
        page={{ ...EMPTY_PAGE, ok: false }}
        state={DESK_DEFAULT_WINDOW_STATE}
        basePath="/ownership"
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(FLOWS_OUTAGE);
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("says nothing is drawn for a read with no positions to estimate", () => {
    render(<OwnershipFlowsStatic page={EMPTY_PAGE} state={DESK_DEFAULT_WINDOW_STATE} basePath="/ownership" />);
    expect(
      screen.getByText("No disclosed holding has a market cap to estimate it from, so nothing is drawn."),
    ).toBeInTheDocument();
  });
});

describe("OwnershipFlows island", () => {
  it("switches between the positions and the window's changes, and says so in the caption", () => {
    const loadFlows = jest.fn<Promise<OwnershipFlowsPage>, [DeskRangeInput]>();
    const { rerender } = render(<OwnershipFlows initial={PAGE} loadFlows={loadFlows} basePath="/ownership" />);
    const modes = screen.getByRole("group", { name: "What the bands show" });
    expect(within(modes).getByRole("button", { name: "Positions" })).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(within(modes).getByRole("button", { name: "Changes" }));
    // The mode is a link parameter (spec 14.8): the click writes view=changes in place, and the page reads it back.
    expect(window.location.search).toContain("view=changes");
    mockSearchParams = new URLSearchParams("view=changes");
    rerender(<OwnershipFlows initial={PAGE} loadFlows={loadFlows} basePath="/ownership" />);
    expect(within(modes).getByRole("button", { name: "Changes" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("table", { name: TABLE_CHANGES })).toBeInTheDocument();
    expect(screen.getByText(/Each band's title says whether its exposure rose or fell/)).toBeInTheDocument();
    expect(loadFlows).not.toHaveBeenCalled();
  });

  it("asks for the window the link names, and keeps the drawing it had while it loads", async () => {
    let resolve: (page: OwnershipFlowsPage) => void = () => undefined;
    const loadFlows = jest.fn(
      () => new Promise<OwnershipFlowsPage>((done) => (resolve = done)),
    );
    const { rerender } = render(<OwnershipFlows initial={PAGE} loadFlows={loadFlows} basePath="/ownership" />);
    mockSearchParams = new URLSearchParams("window=28");
    rerender(<OwnershipFlows initial={PAGE} loadFlows={loadFlows} basePath="/ownership" />);
    expect(loadFlows).toHaveBeenCalledWith({ window: 28 });
    expect(screen.getByText(FLOWS_LOADING)).toBeInTheDocument();
    expect(screen.getByRole("table", { name: TABLE_POSITIONS })).toBeInTheDocument();

    await act(async () => {
      resolve({ ...PAGE, asOf: "2026-11-03" });
    });
    expect(screen.queryByText(FLOWS_LOADING)).toBeNull();
  });

  it("asks for a brushed pair as a pair of dates", () => {
    const loadFlows = jest.fn(() => new Promise<OwnershipFlowsPage>(() => undefined));
    const { rerender } = render(<OwnershipFlows initial={PAGE} loadFlows={loadFlows} basePath="/ownership" />);
    mockSearchParams = new URLSearchParams("since=2026-10-12&until=2026-10-31");
    rerender(<OwnershipFlows initial={PAGE} loadFlows={loadFlows} basePath="/ownership" />);
    expect(loadFlows).toHaveBeenCalledWith({ since: "2026-10-12", until: "2026-10-31" });
  });

  it("lets only the newest window write, so a slow answer for an older window never lands", async () => {
    const answers: Record<string, (page: OwnershipFlowsPage) => void> = {};
    const loadFlows = jest.fn(
      (input: DeskRangeInput) =>
        new Promise<OwnershipFlowsPage>((done) => {
          answers[String(input.window)] = done;
        }),
    );
    const { rerender } = render(<OwnershipFlows initial={PAGE} loadFlows={loadFlows} basePath="/ownership" />);
    mockSearchParams = new URLSearchParams("window=28");
    rerender(<OwnershipFlows initial={PAGE} loadFlows={loadFlows} basePath="/ownership" />);
    mockSearchParams = new URLSearchParams("window=182");
    rerender(<OwnershipFlows initial={PAGE} loadFlows={loadFlows} basePath="/ownership" />);
    await act(async () => {
      answers["182"]!({ ...PAGE, asOf: "2026-11-03", positions: [] });
    });
    await act(async () => {
      answers["28"]!({ ...PAGE, asOf: "2026-10-01" });
    });
    // The newest answer is the one on the screen; the older window's answer never replaced it.
    expect(screen.getByText("2026-11-03")).toBeInTheDocument();
    expect(screen.queryByText("2026-10-01")).toBeNull();
    expect(screen.queryByText(FLOWS_LOADING)).toBeNull();
  });

  it("says the flows could not be read when the request fails", async () => {
    const loadFlows = jest.fn(() => Promise.reject(new Error("network")));
    const { rerender } = render(<OwnershipFlows initial={PAGE} loadFlows={loadFlows} basePath="/ownership" />);
    mockSearchParams = new URLSearchParams("window=28");
    rerender(<OwnershipFlows initial={PAGE} loadFlows={loadFlows} basePath="/ownership" />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByRole("status")).toHaveTextContent(FLOWS_OUTAGE);
  });
});

describe("the measure a band states", () => {
  it("states a count of interests, never dollars, in count mode", () => {
    expect(
      positionBandTitle(
        {
          kind: "super_fund",
          industry: "Materials",
          exposureAud: 12,
          holdings: 12,
          largestCode: "",
          largestPct: null,
        },
        "count",
      ),
    ).toBe("Super fund in Materials: 12 holdings disclosed");
    expect(
      changeBandTitle({ kind: "super_fund", industry: "Materials", direction: "up", exposureAud: 3, notices: 3 }, "count"),
    ).toBe("Super fund, increases in Materials: 3 notices released");
  });

  it("names a connection the workspace selection holds, and only that one", () => {
    const params = new URLSearchParams("sel=connection%3Asuper_fund%3EMaterials");
    expect(connectionIsSelected(params, "super_fund", "Materials")).toBe(true);
    expect(connectionIsSelected(params, "super_fund", "Energy")).toBe(false);
    expect(connectionIsSelected(new URLSearchParams(""), "super_fund", "Materials")).toBe(false);
  });
});
