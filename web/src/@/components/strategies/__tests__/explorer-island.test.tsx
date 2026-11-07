import { act, fireEvent, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom";

import { ExplorerIsland } from "../explorer-island";
import { buildExplorerModel } from "~/@/lib/strategies/explorer";
import { DEFS, EVIDENCE } from "~/@/lib/strategies/__tests__/golden-explorer";

let mockParams = new URLSearchParams();
let mockSession: { data: unknown; status: string } = { data: null, status: "unauthenticated" };

jest.mock("next/navigation", () => ({
  useSearchParams: () => mockParams,
}));
jest.mock("next-auth/react", () => ({
  useSession: () => mockSession,
}));

const NOW = new Date(Date.UTC(2026, 10, 7));
const MODEL = buildExplorerModel({ strategies: DEFS, evidence: EVIDENCE, now: NOW });
const HEADER = <h1>Strategies</h1>;

function setAddress(query: string) {
  window.history.replaceState(null, "", `/strategies${query}`);
}

describe("ExplorerIsland", () => {
  let replaceState: jest.SpyInstance;

  beforeEach(() => {
    mockParams = new URLSearchParams();
    mockSession = { data: null, status: "unauthenticated" };
    setAddress("");
    replaceState = jest.spyOn(window.history, "replaceState");
  });

  afterEach(() => {
    replaceState.mockRestore();
  });

  it("opens on the default selection and window when the address names none", () => {
    render(<ExplorerIsland model={MODEL} header={HEADER} />);
    expect(document.querySelector('[data-inspector="crowded-short-breakout"]')).not.toBeNull();
    expect(screen.getByRole("combobox", { name: "Window" })).toHaveValue("since_2019_05");
  });

  it("reads the window, the selection and the tray from the address when it mounts", () => {
    mockParams = new URLSearchParams("window=since_2023&sel=strategy:canslim&ids=canslim,zanger-breakout");
    render(<ExplorerIsland model={MODEL} header={HEADER} />);
    expect(screen.getByRole("combobox", { name: "Window" })).toHaveValue("since_2023");
    expect(document.querySelector('[data-inspector="canslim"]')).not.toBeNull();
    expect(screen.getByRole("region", { name: "Strategies to compare" })).toHaveTextContent("2 strategies selected");
  });

  it("writes a changed filter to the address without navigating", () => {
    render(<ExplorerIsland model={MODEL} header={HEADER} />);
    fireEvent.change(screen.getByRole("combobox", { name: "Evidence" }), { target: { value: "backtested" } });
    expect(replaceState).toHaveBeenLastCalledWith(null, "", "/strategies?evidence=backtested");
    expect(screen.queryByRole("rowheader", { name: /Zanger/ })).toBeNull();
  });

  it("writes the search as q= and filters the rows", () => {
    render(<ExplorerIsland model={MODEL} header={HEADER} />);
    fireEvent.change(screen.getByRole("searchbox", { name: "Find a strategy" }), { target: { value: "canslim" } });
    expect(replaceState).toHaveBeenLastCalledWith(null, "", "/strategies?q=canslim");
    expect(screen.getByRole("rowheader", { name: /CAN SLIM/ })).toBeInTheDocument();
    expect(screen.queryByRole("rowheader", { name: /Zanger/ })).toBeNull();
  });

  it("selects a row from its name and moves the rail to it", () => {
    render(<ExplorerIsland model={MODEL} header={HEADER} />);
    fireEvent.click(screen.getByRole("button", { name: "Minervini Trend Template" }));
    expect(replaceState).toHaveBeenLastCalledWith(null, "", "/strategies?sel=strategy%3Aminervini-trend-template");
    expect(document.querySelector('[data-inspector="minervini-trend-template"]')).not.toBeNull();
  });

  it("holds three picks: a fourth tick is refused, and a removal frees a place", () => {
    render(<ExplorerIsland model={MODEL} header={HEADER} />);
    for (const name of ["Zanger Breakout", "CAN SLIM", "Minervini Trend Template"]) {
      fireEvent.click(screen.getByRole("checkbox", { name: `Compare ${name}` }));
    }
    expect(replaceState).toHaveBeenLastCalledWith(
      null,
      "",
      "/strategies?ids=zanger-breakout,canslim,minervini-trend-template",
    );
    expect(screen.getByRole("checkbox", { name: "Compare Quality compounders" })).toBeDisabled();

    const tray = screen.getByRole("region", { name: "Strategies to compare" });
    fireEvent.click(within(tray).getByRole("button", { name: "Remove CAN SLIM" }));
    expect(screen.getByRole("checkbox", { name: "Compare Quality compounders" })).toBeEnabled();
    expect(screen.getByRole("checkbox", { name: "Compare CAN SLIM" })).not.toBeChecked();
  });

  it("offers an anonymous reader the sign-in prompt in the tray", () => {
    render(<ExplorerIsland model={MODEL} header={HEADER} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Compare CAN SLIM" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Compare Zanger Breakout" }));
    expect(screen.getByRole("link", { name: "Sign in to compare" })).toBeInTheDocument();
  });

  it("offers a signed-in reader the comparison", () => {
    mockSession = { data: { user: { id: "u1" } }, status: "authenticated" };
    render(<ExplorerIsland model={MODEL} header={HEADER} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Compare CAN SLIM" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Compare Zanger Breakout" }));
    expect(screen.getByRole("link", { name: "Compare strategies →" })).toHaveAttribute(
      "href",
      "/strategies/compare?ids=canslim,zanger-breakout",
    );
  });

  it("returns to the default address when the filters are cleared", () => {
    mockParams = new URLSearchParams("evidence=backtested");
    render(<ExplorerIsland model={MODEL} header={HEADER} />);
    act(() => {
      fireEvent.change(screen.getByRole("combobox", { name: "Evidence" }), { target: { value: "all" } });
    });
    expect(replaceState).toHaveBeenLastCalledWith(null, "", "/strategies");
  });
});
