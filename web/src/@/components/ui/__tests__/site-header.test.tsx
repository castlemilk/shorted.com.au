import { act, render, screen } from "@testing-library/react";

// The nav's own behaviour is not under test here: two links stand in for it, so
// Tab across the header has something to land on.
jest.mock("../main-nav", () => ({
  MainNav: () => (
    <nav aria-label="Main">
      <a href="/top">most shorted</a>
      <a href="/screener">screener</a>
    </nav>
  ),
}));
jest.mock("../mode-toggle", () => ({ ModeToggle: () => null }));

import SiteHeader from "../site-header";

// A control that takes keyboard focus under the site header is scrolled clear
// of it (WCAG 2.2 SC 2.4.11, Focus Not Obscured), as one under the stock page's
// docked tab bar is. jsdom has no layout, so the boxes are given: the header is
// stuck at the top, 65px tall (its 64px row and its 1px border), so a control
// is clear from 65 + 8 = 73px down.
describe("SiteHeader keeps focus clear of itself", () => {
  const HEADER_BOTTOM = 65;
  const CLEAR_TOP = HEADER_BOTTOM + 8;

  let scrollBy: jest.SpyInstance;
  let main: HTMLElement;

  const box = (top: number, height = 24, left = 100, width = 200) =>
    ({ top, bottom: top + height, left, right: left + width, width, height, x: left, y: top }) as DOMRect;

  const header = () => document.querySelector("header")!;

  // The header, at `top` (0 is stuck at the top of the screen).
  const mountHeader = (top = 0) => {
    const view = render(<SiteHeader />);
    jest.spyOn(header(), "getBoundingClientRect").mockReturnValue(box(top, HEADER_BOTTOM, 0, 1280));
    return view;
  };

  // A control in the page's <main>, at `top`.
  const control = (top: number, options: { parent?: Element; tag?: "a" | "button" | "input"; height?: number } = {}) => {
    const el = document.createElement(options.tag ?? "a");
    if (el instanceof HTMLAnchorElement) el.href = "#probe";
    (options.parent ?? main).appendChild(el);
    jest.spyOn(el, "getBoundingClientRect").mockReturnValue(box(top, options.height));
    return el;
  };
  const focus = (el: HTMLElement) => act(() => el.focus());

  // A position: sticky element with its sticky top at `stickyTop`, drawn at `top`.
  const sticky = (stickyTop: number, top: number) => {
    const el = document.createElement("div");
    el.style.position = "sticky";
    el.style.top = `${stickyTop}px`;
    main.appendChild(el);
    jest.spyOn(el, "getBoundingClientRect").mockReturnValue(box(top, 45, 0, 1280));
    return el;
  };

  beforeEach(() => {
    scrollBy = jest.spyOn(window, "scrollBy").mockImplementation(() => undefined);
    main = document.createElement("main");
    document.body.appendChild(main);
  });
  afterEach(() => {
    jest.restoreAllMocks();
    main.remove();
    document.body.querySelectorAll("dialog, [role=dialog]").forEach((el) => el.remove());
  });

  it("scrolls up until a link focused at 30px sits 8px under the header", () => {
    mountHeader();
    focus(control(30));
    expect(scrollBy).toHaveBeenCalledTimes(1);
    expect(scrollBy).toHaveBeenCalledWith({ top: 30 - CLEAR_TOP });
  });

  it.each([["button"], ["input"]] as const)("does the same for a %s", (tag) => {
    mountHeader();
    focus(control(40, { tag }));
    expect(scrollBy).toHaveBeenCalledWith({ top: 40 - CLEAR_TOP });
  });

  it("scrolls a control that is partly above the screen, by its top", () => {
    mountHeader();
    focus(control(-20, { height: 40 })); // -20 to 20: its bottom is on screen
    expect(scrollBy).toHaveBeenCalledWith({ top: -20 - CLEAR_TOP });
  });

  it("leaves a control that is clear of the header alone, to the pixel", () => {
    mountHeader();
    focus(control(CLEAR_TOP));
    focus(control(300));
    expect(scrollBy).not.toHaveBeenCalled();
    focus(control(CLEAR_TOP - 1));
    expect(scrollBy).toHaveBeenCalledWith({ top: -1 });
  });

  it("leaves a control that is wholly above the screen to the browser, which centres it", () => {
    mountHeader();
    focus(control(-100, { height: 40 }));
    focus(control(-40, { height: 40 }));
    expect(scrollBy).not.toHaveBeenCalled();
  });

  it("does nothing while something above the header holds it down the page, where nothing is under it", () => {
    mountHeader(40); // a banner above it, at the top of the page
    focus(control(60));
    expect(scrollBy).not.toHaveBeenCalled();
  });

  it("does not move the page for a control the visitor reached with the pointer", () => {
    mountHeader();
    const link = control(30);
    const matches = Element.prototype.matches;
    jest.spyOn(Element.prototype, "matches").mockImplementation(function (this: Element, selector: string) {
      return selector === ":focus-visible" ? false : matches.call(this, selector);
    });
    focus(link);
    expect(document.activeElement).toBe(link);
    expect(scrollBy).not.toHaveBeenCalled();
  });

  describe("never for a control that scrolling cannot clear", () => {
    it("leaves the header's own links alone: Tab across the header never moves the page", () => {
      mountHeader();
      for (const link of screen.getAllByRole("link")) {
        jest.spyOn(link, "getBoundingClientRect").mockReturnValue(box(20));
        focus(link);
      }
      expect(scrollBy).not.toHaveBeenCalled();
    });

    it("leaves a control on a bar stuck under it alone: Tab across the docked stock tabs never moves the page", () => {
      mountHeader();
      const bar = sticky(64, 64);
      focus(control(64, { parent: bar }));
      focus(control(65, { parent: bar }));
      expect(scrollBy).not.toHaveBeenCalled();
    });

    it("still moves the page for a control on a sticky bar that is not stuck, which scrolls with the page", () => {
      mountHeader();
      const leaving = sticky(64, 20); // its section has ended and it is scrolling away
      focus(control(30, { parent: leaving }));
      expect(scrollBy).toHaveBeenCalledWith({ top: 30 - CLEAR_TOP });
    });

    it.each([
      ["a dialog", () => { const d = document.createElement("div"); d.setAttribute("role", "dialog"); return d; }],
      ["a native <dialog>", () => document.createElement("dialog")],
    ])("leaves a control in %s alone", (_name, make) => {
      mountHeader();
      const surface = make();
      document.body.appendChild(surface);
      focus(control(30, { parent: surface }));
      expect(scrollBy).not.toHaveBeenCalled();
    });

    it("leaves a control with a position: fixed ancestor alone", () => {
      mountHeader();
      const fixed = document.createElement("div");
      fixed.style.position = "fixed";
      main.appendChild(fixed);
      focus(control(30, { parent: fixed }));
      expect(scrollBy).not.toHaveBeenCalled();
    });
  });

  it("listens on the document, once, and stops when it unmounts", () => {
    const add = jest.spyOn(document, "addEventListener");
    const remove = jest.spyOn(document, "removeEventListener");
    const view = mountHeader();
    const added = add.mock.calls.filter(([type]) => type === "focusin");
    expect(added).toHaveLength(1);

    view.unmount();
    const removed = remove.mock.calls.filter(([type]) => type === "focusin");
    expect(removed).toHaveLength(1);
    expect(removed[0]![1]).toBe(added[0]![1]);

    focus(control(30));
    expect(scrollBy).not.toHaveBeenCalled();
  });
});
