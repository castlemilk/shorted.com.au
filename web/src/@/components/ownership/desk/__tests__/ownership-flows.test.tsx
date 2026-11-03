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
  OwnershipFlowsStatic,
  changeBandTitle,
  flowRegisterHref,
  kindColour,
  positionBandTitle,
  shortenLabel,
} from "../ownership-flows-static";
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

  it("colours a kind with its category swatch, and shortens a label to its room", () => {
    expect(kindColour("super_fund")).toBe("#87A96B");
    expect(shortenLabel("Sovereign or public fund", 13)).toBe("Sovereign or…");
    expect(shortenLabel("Insurer", 13)).toBe("Insurer");
  });
});

describe("OwnershipFlowsStatic", () => {
  it("draws the positions with the caption the spec gives, and the mode row disabled on the server", () => {
    render(<OwnershipFlowsStatic page={PAGE} state={DESK_DEFAULT_WINDOW_STATE} basePath="/ownership" />);
    expect(screen.getByText(FLOW_POSITIONS_CAPTION)).toBeInTheDocument();
    const modes = screen.getByRole("group", { name: "What the bands show" });
    expect(within(modes).getByRole("button", { name: "Positions" })).toBeDisabled();
    expect(within(modes).getByRole("button", { name: "Positions" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("group", { name: "Window of change" })).toBeInTheDocument();
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
    expect(within(table).getByRole("link", { name: "Other" })).toHaveAttribute("href", "/ownership?sector=Other");
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
      "Super fund in Materials: A$3.0B disclosed exposure, estimated, across 4 holdings; largest BHP at 9.20%",
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
      "/ownership?sector=Materials",
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
    render(<OwnershipFlows initial={PAGE} loadFlows={loadFlows} basePath="/ownership" />);
    const modes = screen.getByRole("group", { name: "What the bands show" });
    expect(within(modes).getByRole("button", { name: "Positions" })).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(within(modes).getByRole("button", { name: "Changes in the window" }));
    expect(within(modes).getByRole("button", { name: "Changes in the window" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("table", { name: TABLE_CHANGES })).toBeInTheDocument();
    expect(screen.getByText(/Increases are amber and decreases ink/)).toBeInTheDocument();
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
