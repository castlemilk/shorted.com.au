/// <reference types="jest" />
import "@testing-library/jest-dom";

/**
 * The stock Overview's sign-in slot end to end: the page's own frame round the
 * banner, the REAL session gate and the REAL banner. page-overview.test.tsx
 * stubs both and holds the frame's classes; this holds what a dismissal does to
 * the frame. Dismissing renders the banner null, and the bordered frame the page
 * draws round it must go with it: left behind it was a 2px sliver of border above
 * the grid. The frame is `empty:hidden`, which hides it only if the banner leaves
 * it with no child at all.
 *
 * jsdom loads no Tailwind, so the one rule the class stands for is written out
 * here (it is what `empty:hidden` compiles to), and the frame's computed display
 * is read against it.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import {
  mockGetStockFundamentals,
  mockGetStockStrategyFit,
  mockListStrategies,
} from "./overview-page-mocks";

jest.mock("next/dynamic", () => () => () => <div data-testid="chart-panel" />);
jest.mock("../short-interest-summary", () => ({
  ...jest.requireActual<typeof import("../short-interest-summary")>("../short-interest-summary"),
  getShortInterestDeltas: jest.fn(async () => ({
    change7d: null,
    change30d: null,
    change90d: null,
    peakPct: null,
    peakDate: null,
  })),
}));
jest.mock("~/app/actions/getStockDetails", () => ({
  getStockDetails: jest.fn(async () => null),
}));
jest.mock("~/@/components/themes/theme-chips", () => ({ StockThemeChips: () => null }));
// The real gate and the real banner (the shared jest setup stubs the banner).
// The real SignIn is a form whose action is a server action, which React 18
// cannot render in jsdom, so it is a stand-in.
jest.mock("~/@/components/ui/login-prompt-banner", () =>
  jest.requireActual("~/@/components/ui/login-prompt-banner"),
);
jest.mock("~/@/components/ui/session-gates", () =>
  jest.requireActual("~/@/components/ui/session-gates"),
);
jest.mock("~/@/components/ui/sign-in", () => ({
  SignIn: () => <button type="button">Sign in</button>,
}));

import Page from "../page";

// What Tailwind compiles `empty:hidden` to.
const EMPTY_HIDDEN_RULE = ".empty\\:hidden:empty { display: none; }";

describe("the Overview's sign-in slot when the banner is dismissed", () => {
  let style: HTMLStyleElement;

  beforeEach(() => {
    jest
      .requireActual<{ useSession: jest.Mock }>("next-auth/react")
      .useSession.mockReturnValue({ data: null, status: "unauthenticated", update: jest.fn() });
    mockGetStockFundamentals.mockRejectedValue(new Error("unavailable"));
    mockGetStockStrategyFit.mockRejectedValue(new Error("unavailable"));
    mockListStrategies.mockRejectedValue(new Error("unavailable"));
    jest.spyOn(console, "warn").mockImplementation(() => undefined);
    jest.spyOn(console, "error").mockImplementation(() => undefined);
    style = document.createElement("style");
    style.textContent = EMPTY_HIDDEN_RULE;
    document.head.appendChild(style);
    document.documentElement.classList.add("anon");
  });
  afterEach(() => {
    style.remove();
    document.documentElement.classList.remove("anon");
    jest.restoreAllMocks();
  });

  async function renderOverview() {
    const view = render(await Page({ params: Promise.resolve({ stockCode: "bhp" }) }));
    const slot = view.container.querySelector(".login-slot") as HTMLElement;
    return { slot, frame: slot.firstElementChild as HTMLElement };
  }

  it("shows the banner in the page's frame while the visitor is signed out", async () => {
    const { slot, frame } = await renderOverview();
    expect(slot.children).toHaveLength(1);
    expect(frame).toHaveClass("overflow-hidden", "rounded-lg", "border", "empty:hidden");
    expect(frame.matches(":empty")).toBe(false);
    expect(frame).toContainElement(screen.getByRole("button", { name: "Close" }));
    expect(getComputedStyle(frame).display).not.toBe("none");
  });

  it("leaves the frame empty and hidden after Close, so no sliver of border is left", async () => {
    const { slot, frame } = await renderOverview();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
    // The frame is still there (the gate still shows its children) but holds
    // nothing: not a button, not a text node.
    expect(slot.firstElementChild).toBe(frame);
    expect(frame.childNodes).toHaveLength(0);
    expect(frame.matches(":empty")).toBe(true);
    expect(getComputedStyle(frame).display).toBe("none");
    // And the slot's reservation is released with it.
    expect(document.documentElement).not.toHaveClass("anon");
  });
});
