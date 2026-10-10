import { act, fireEvent, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";

const prefetch = jest.fn();
let pathname = "/shorts/BHP/strategy";
jest.mock("next/navigation", () => ({
  useRouter: () => ({ prefetch, push: jest.fn(), replace: jest.fn() }),
  usePathname: () => pathname,
}));
// Like Next's Link: the link's own onClick runs first, then the click is taken
// over (so jsdom never tries to navigate). `scroll` is exposed, not forwarded.
jest.mock("next/link", () => ({
  __esModule: true,
  default: ({
    children,
    href,
    prefetch,
    scroll,
    onClick,
    ...rest
  }: {
    children: React.ReactNode;
    href: string;
    prefetch?: boolean;
    scroll?: boolean;
    onClick?: (e: React.MouseEvent<HTMLAnchorElement>) => void;
  }) => (
    <a
      href={href}
      data-prefetch={String(prefetch)}
      data-scroll={String(scroll)}
      onClick={(e) => {
        onClick?.(e);
        e.preventDefault();
      }}
      {...rest}
    >
      {children}
    </a>
  ),
}));
// The shared jest setup stubs lib/utils down to `cn`. The bar also reads
// isPlainLeftClick, and the real `cn` shows the classes production emits.
jest.mock("~/@/lib/utils", () => jest.requireActual("~/@/lib/utils"));

import { StockTabNav } from "../stock-tab-nav";

const navigation = () => screen.getByRole("navigation", { name: "Stock sections" });

describe("StockTabNav", () => {
  beforeEach(() => {
    prefetch.mockClear();
    pathname = "/shorts/BHP/strategy";
  });

  it("renders seven links and marks the active one from the pathname", () => {
    render(<StockTabNav stockCode="BHP" />);
    const links = screen.getAllByRole("link");
    expect(links).toHaveLength(7);
    expect(links.map((l) => l.getAttribute("href"))).toEqual([
      "/shorts/BHP", "/shorts/BHP/short-interest", "/shorts/BHP/strategy", "/shorts/BHP/financials",
      "/shorts/BHP/company", "/shorts/BHP/news", "/shorts/BHP/community",
    ]);
    expect(screen.getByRole("link", { name: "Strategy" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Overview" })).not.toHaveAttribute("aria-current");
  });

  it("prefetches on intent only, once per href", () => {
    render(<StockTabNav stockCode="BHP" />);
    expect(prefetch).not.toHaveBeenCalled();
    const financials = screen.getByRole("link", { name: "Financials" });
    fireEvent.pointerEnter(financials);
    fireEvent.focus(financials);
    fireEvent.touchStart(financials);
    expect(prefetch).toHaveBeenCalledTimes(1);
    expect(prefetch).toHaveBeenCalledWith("/shorts/BHP/financials");
    fireEvent.pointerEnter(screen.getByRole("link", { name: "News" }));
    expect(prefetch).toHaveBeenCalledTimes(2);
  });

  it("never prefetches the active tab", () => {
    render(<StockTabNav stockCode="BHP" />);
    fireEvent.pointerEnter(screen.getByRole("link", { name: "Strategy" }));
    expect(prefetch).not.toHaveBeenCalled();
  });

  // The test above fires all three triggers on one link, so it cannot tell a
  // missing handler from a deduped one: pin each trigger on its own.
  const triggers: [string, typeof fireEvent.pointerEnter][] = [
    ["pointer enter", fireEvent.pointerEnter],
    ["touch start", fireEvent.touchStart],
    ["focus", fireEvent.focus],
  ];
  it.each(triggers)("prefetches on %s alone", (_name, fire) => {
    render(<StockTabNav stockCode="BHP" />);
    fire(screen.getByRole("link", { name: "Company" }));
    expect(prefetch).toHaveBeenCalledTimes(1);
    expect(prefetch).toHaveBeenCalledWith("/shorts/BHP/company");
  });

  it("turns off Link's own prefetch on every tab, so only intent prefetches", () => {
    render(<StockTabNav stockCode="BHP" />);
    for (const link of screen.getAllByRole("link")) {
      expect(link).toHaveAttribute("data-prefetch", "false");
    }
  });

  it("turns off Link's own scroll on every tab, so the bar decides where the page lands", () => {
    render(<StockTabNav stockCode="BHP" />);
    for (const link of screen.getAllByRole("link")) {
      expect(link).toHaveAttribute("data-scroll", "false");
    }
  });
});

describe("StockTabNav markup", () => {
  beforeEach(() => {
    pathname = "/shorts/BHP/strategy";
  });

  it("is sticky under the site header, translucent, and bleeds to the edges of main", () => {
    render(<StockTabNav stockCode="BHP" />);
    expect(navigation()).toHaveClass(
      "sticky", "top-16", "z-30", "-mx-8", "mb-4", "border-b", "border-border",
      "bg-background/90", "backdrop-blur", "supports-[backdrop-filter]:bg-background/75",
    );
  });

  // The page's 2rem gutter is given back by the bar's -mx-8. If the bar kept
  // its own px-8, the scrolling list would sit inside it and the tabs would clip
  // 32px short of the screen's edge. The padding belongs to the list.
  it("leaves the gutter's padding to the scrolling list, so the tabs scroll to the edge", () => {
    render(<StockTabNav stockCode="BHP" />);
    expect(navigation()).not.toHaveClass("px-8");
    expect(navigation().firstElementChild).toHaveClass("px-8", "scroll-px-8");
  });

  it("puts a zero-height sentinel in the flow just before the bar, hidden from assistive technology", () => {
    render(<StockTabNav stockCode="BHP" />);
    const sentinel = navigation().previousElementSibling;
    expect(sentinel).toHaveAttribute("aria-hidden", "true");
    expect(sentinel).toHaveClass("h-0");
    expect(sentinel).toBeEmptyDOMElement();
  });

  it("is a 44px row of links that stretch to its full height, and scrolls sideways", () => {
    render(<StockTabNav stockCode="BHP" />);
    const list = navigation().firstElementChild;
    expect(list).toHaveClass("relative", "flex", "h-11", "items-stretch", "gap-1", "overflow-x-auto");
  });

  // The row has no height to spare for a classic scrollbar (15px of its 44).
  it("hides the list's scrollbar in both engines, and still scrolls", () => {
    render(<StockTabNav stockCode="BHP" />);
    const list = navigation().firstElementChild;
    expect(list).toHaveClass("[scrollbar-width:none]", "[&::-webkit-scrollbar]:hidden", "overflow-x-auto");
  });

  it("draws the active tab in foreground weight with a 2px Burnt Amber underline", () => {
    render(<StockTabNav stockCode="BHP" />);
    const active = screen.getByRole("link", { name: "Strategy" });
    expect(active).toHaveClass(
      "relative", "inline-flex", "shrink-0", "items-center", "px-3", "font-mono", "text-sm",
      "transition-colors", "font-semibold", "text-foreground",
    );
    const underline = active.querySelector("span");
    expect(underline).toHaveAttribute("aria-hidden", "true");
    expect(underline).toHaveClass("absolute", "inset-x-0", "bottom-0", "h-0.5", "bg-primary");
  });

  it("draws the other tabs muted, with no underline", () => {
    render(<StockTabNav stockCode="BHP" />);
    for (const name of ["Overview", "Short interest", "Financials", "Company", "News", "Community"]) {
      const link = screen.getByRole("link", { name });
      expect(link).toHaveClass("relative", "inline-flex", "shrink-0", "items-center", "px-3", "font-mono", "text-sm");
      expect(link).toHaveClass("text-muted-foreground", "hover:text-foreground");
      expect(link).not.toHaveClass("font-semibold");
      expect(link.querySelector("span")).toBeNull();
    }
  });

  it("has no opaque track behind the links", () => {
    render(<StockTabNav stockCode="BHP" />);
    expect(navigation().querySelector(".bg-muted")).toBeNull();
    expect(navigation().innerHTML).not.toMatch(/\bbg-background\b(?!\/)/);
  });

  it("names the tab by its label alone: the underline adds nothing a screen reader would say", () => {
    render(<StockTabNav stockCode="BHP" />);
    expect(screen.getByRole("link", { name: "Strategy" })).toHaveTextContent(/^Strategy$/);
  });

  it("draws its focus ring inside each link, where the scrolling list cannot clip it", () => {
    render(<StockTabNav stockCode="BHP" />);
    for (const link of screen.getAllByRole("link")) {
      expect(link).toHaveClass("focus-visible:ring-2", "focus-visible:ring-inset", "focus-visible:ring-ring");
    }
  });
});

// With the active tab outside the visible part of the scrolling list, the bar
// scrolls the list to show it. jsdom has no layout, so the boxes are given.
describe("StockTabNav keeps the active tab in view", () => {
  const defined: [object, string, PropertyDescriptor | undefined][] = [];
  const define = (target: object, key: string, value: unknown) => {
    defined.push([target, key, Object.getOwnPropertyDescriptor(target, key)]);
    Object.defineProperty(target, key, { value, configurable: true });
  };
  afterEach(() => {
    for (const [target, key, original] of defined.splice(0).reverse()) {
      if (original) Object.defineProperty(target, key, original);
      else delete (target as Record<string, unknown>)[key];
    }
  });

  it("scrolls the list to a tab that is past its right edge, 16px of context to its left", () => {
    pathname = "/shorts/BHP/community";
    const scrollTo = jest.fn();
    define(HTMLElement.prototype, "scrollTo", scrollTo);
    define(HTMLElement.prototype, "clientWidth", 300);
    define(HTMLElement.prototype, "scrollLeft", 0);
    define(HTMLElement.prototype, "offsetWidth", 90);
    define(HTMLElement.prototype, "offsetLeft", 500);
    render(<StockTabNav stockCode="BHP" />);
    expect(scrollTo).toHaveBeenCalledWith({ left: 484 });
  });

  // The list carries the 32px gutter as padding, and offsetLeft counts it: the
  // first tab sits 32px in, which is inside the list, not 32px of overflow.
  it("leaves the list alone when the active tab is already visible", () => {
    pathname = "/shorts/BHP";
    const scrollTo = jest.fn();
    define(HTMLElement.prototype, "scrollTo", scrollTo);
    define(HTMLElement.prototype, "clientWidth", 300);
    define(HTMLElement.prototype, "scrollLeft", 0);
    define(HTMLElement.prototype, "offsetWidth", 90);
    define(HTMLElement.prototype, "offsetLeft", 32);
    render(<StockTabNav stockCode="BHP" />);
    expect(scrollTo).not.toHaveBeenCalled();
  });

  // Back or forward from a far tab. The first tab has no tab before it to show,
  // so it goes to the start of the list, where it rests at the gutter. 16px in
  // (offsetLeft - 16) would leave it 16px off the page's line.
  it("scrolls the list back to its start for the first tab, which has no tab before it to show", () => {
    pathname = "/shorts/BHP";
    const scrollTo = jest.fn();
    define(HTMLElement.prototype, "scrollTo", scrollTo);
    define(HTMLElement.prototype, "clientWidth", 300);
    define(HTMLElement.prototype, "scrollLeft", 400);
    define(HTMLElement.prototype, "offsetWidth", 90);
    define(HTMLElement.prototype, "offsetLeft", 32);
    render(<StockTabNav stockCode="BHP" />);
    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(scrollTo).toHaveBeenCalledWith({ left: 0 });
  });

  it("scrolls the list back to a later tab that has been scrolled out on its left, 16px of context to its left", () => {
    pathname = "/shorts/BHP/short-interest";
    const scrollTo = jest.fn();
    define(HTMLElement.prototype, "scrollTo", scrollTo);
    define(HTMLElement.prototype, "clientWidth", 300);
    define(HTMLElement.prototype, "scrollLeft", 400);
    define(HTMLElement.prototype, "offsetWidth", 90);
    define(HTMLElement.prototype, "offsetLeft", 124);
    render(<StockTabNav stockCode="BHP" />);
    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(scrollTo).toHaveBeenCalledWith({ left: 108 });
  });
});

// A tab switch leaves the page where the new tab starts directly under the
// docked bar, and moves it only when the bar was docked (spec D2).
describe("StockTabNav scroll on a tab switch", () => {
  // The bar's place in the document: where the sentinel sits. With the bar
  // docked at top-16 (64px), the page scrolls to DOCK_Y = 300 - 64 to put the
  // bar there.
  const SENTINEL_DOCUMENT_TOP = 300;
  const STICKY_TOP = 64;
  const DOCK_Y = SENTINEL_DOCUMENT_TOP - STICKY_TOP;

  let scrollTo: jest.SpyInstance;
  const setScroll = (x: number, y: number) => {
    Object.defineProperty(window, "scrollX", { value: x, configurable: true });
    Object.defineProperty(window, "scrollY", { value: y, configurable: true });
  };
  // The sentinel moves with the document, so its viewport top is its document
  // top less the scroll, the way a browser reports it.
  const placeSentinel = () => {
    jest.spyOn(navigation().previousElementSibling as Element, "getBoundingClientRect").mockImplementation(
      () => ({ top: SENTINEL_DOCUMENT_TOP - window.scrollY }) as DOMRect,
    );
  };
  const mountAt = (initialPath: string) => {
    pathname = initialPath;
    const view = render(<StockTabNav stockCode="BHP" />);
    placeSentinel();
    return {
      goTo: (nextPath: string) => {
        pathname = nextPath;
        view.rerender(<StockTabNav stockCode="BHP" />);
      },
    };
  };

  beforeEach(() => {
    scrollTo = jest.spyOn(window, "scrollTo").mockImplementation(() => undefined);
    setScroll(0, 0);
  });
  afterEach(() => {
    jest.restoreAllMocks();
    setScroll(0, 0);
  });

  it("does nothing when it mounts", () => {
    setScroll(0, 900);
    mountAt("/shorts/BHP/strategy");
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("scrolls a docked page to exactly where the bar docks, after a click on a tab", () => {
    const { goTo } = mountAt("/shorts/BHP/strategy");
    setScroll(0, 900);
    fireEvent.click(screen.getByRole("link", { name: "Financials" }));
    // The click only arms it: nothing moves until the tab itself changes.
    expect(scrollTo).not.toHaveBeenCalled();
    goTo("/shorts/BHP/financials");
    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(scrollTo).toHaveBeenCalledWith({ top: DOCK_Y, left: 0 });
  });

  it("keeps the horizontal scroll", () => {
    const { goTo } = mountAt("/shorts/BHP/strategy");
    setScroll(40, 900);
    fireEvent.click(screen.getByRole("link", { name: "News" }));
    goTo("/shorts/BHP/news");
    expect(scrollTo).toHaveBeenCalledWith({ top: DOCK_Y, left: 40 });
  });

  it("leaves a page alone when the bar was not docked", () => {
    const { goTo } = mountAt("/shorts/BHP/strategy");
    setScroll(0, 100);
    fireEvent.click(screen.getByRole("link", { name: "Financials" }));
    goTo("/shorts/BHP/financials");
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("leaves a page at the top alone", () => {
    const { goTo } = mountAt("/shorts/BHP/strategy");
    fireEvent.click(screen.getByRole("link", { name: "Financials" }));
    goTo("/shorts/BHP/financials");
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("allows a pixel for rounding: docked to within 1px stays put, 2px past it scrolls", () => {
    const { goTo } = mountAt("/shorts/BHP/strategy");
    setScroll(0, DOCK_Y + 1);
    fireEvent.click(screen.getByRole("link", { name: "Financials" }));
    goTo("/shorts/BHP/financials");
    expect(scrollTo).not.toHaveBeenCalled();

    setScroll(0, DOCK_Y + 2);
    fireEvent.click(screen.getByRole("link", { name: "News" }));
    goTo("/shorts/BHP/news");
    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(scrollTo).toHaveBeenCalledWith({ top: DOCK_Y, left: 0 });
  });

  it("does not move the page on back or forward, which change the tab without a click", () => {
    const { goTo } = mountAt("/shorts/BHP/strategy");
    setScroll(0, 900);
    goTo("/shorts/BHP/financials");
    goTo("/shorts/BHP/strategy");
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("spends the click on one switch: a later change of tab without one does not move the page", () => {
    const { goTo } = mountAt("/shorts/BHP/strategy");
    setScroll(0, 900);
    fireEvent.click(screen.getByRole("link", { name: "Financials" }));
    goTo("/shorts/BHP/financials");
    expect(scrollTo).toHaveBeenCalledTimes(1);
    goTo("/shorts/BHP/strategy");
    expect(scrollTo).toHaveBeenCalledTimes(1);
  });

  it("does not count a click on the tab that is already open", () => {
    const { goTo } = mountAt("/shorts/BHP/strategy");
    setScroll(0, 900);
    fireEvent.click(screen.getByRole("link", { name: "Strategy" }));
    goTo("/shorts/BHP/financials"); // the visitor then pressed Back
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it.each([["ctrl", { ctrlKey: true }], ["meta", { metaKey: true }], ["shift", { shiftKey: true }], ["alt", { altKey: true }], ["middle button", { button: 1 }]])(
    "does not count a %s click, which opens another window rather than this tab",
    (_name, init) => {
      const { goTo } = mountAt("/shorts/BHP/strategy");
      setScroll(0, 900);
      fireEvent.click(screen.getByRole("link", { name: "Financials" }), init);
      goTo("/shorts/BHP/financials");
      expect(scrollTo).not.toHaveBeenCalled();
    },
  );

  it("reads where the bar docks from its own sticky top rather than assuming 64px", () => {
    const { goTo } = mountAt("/shorts/BHP/strategy");
    navigation().style.top = "80px";
    setScroll(0, 900);
    fireEvent.click(screen.getByRole("link", { name: "Financials" }));
    goTo("/shorts/BHP/financials");
    expect(scrollTo).toHaveBeenCalledWith({ top: SENTINEL_DOCUMENT_TOP - 80, left: 0 });
  });

  it("falls back to 64px when the sticky top cannot be read as a number", () => {
    const { goTo } = mountAt("/shorts/BHP/strategy");
    navigation().style.top = "auto";
    setScroll(0, 900);
    fireEvent.click(screen.getByRole("link", { name: "Financials" }));
    goTo("/shorts/BHP/financials");
    expect(scrollTo).toHaveBeenCalledWith({ top: DOCK_Y, left: 0 });
  });
});

// The bar scrolls sideways on a phone and hides its scrollbar. A peeking tab is
// no cue at 360px (the fourth tab starts at x=368, so nothing of it shows), so
// the list fades the edge that has more tabs behind it, and says so in
// data-scroll-start / data-scroll-end. jsdom has no layout: the list's scroll
// metrics are given, and read live, so a test can scroll the list.
describe("StockTabNav scroll cue", () => {
  // The classes the cue draws, word for word: Tailwind has to find them whole.
  const FADE_END = "[mask-image:linear-gradient(to_right,black_calc(100%-40px),transparent)]";
  const FADE_START = "[mask-image:linear-gradient(to_left,black_calc(100%-40px),transparent)]";
  const FADE_BOTH =
    "[mask-image:linear-gradient(to_right,transparent,black_40px,black_calc(100%-40px),transparent)]";
  const FADES = [FADE_END, FADE_START, FADE_BOTH];

  // A 360px phone: seven tabs make a 760px list (the figures the review measured).
  const metrics = { scrollLeft: 0, clientWidth: 360, scrollWidth: 760 };
  const list = () => navigation().firstElementChild as HTMLElement;
  const fades = () => FADES.filter((fade) => list().classList.contains(fade));

  const defined: [object, string, PropertyDescriptor | undefined][] = [];
  const stub = (target: object, key: string, descriptor: PropertyDescriptor) => {
    defined.push([target, key, Object.getOwnPropertyDescriptor(target, key)]);
    Object.defineProperty(target, key, { configurable: true, ...descriptor });
  };

  // What a ResizeObserver does, as far as the bar can tell: it is told what to
  // watch, it calls back, and it can be disconnected.
  class FakeResizeObserver {
    static instances: FakeResizeObserver[] = [];
    observed: Element[] = [];
    disconnected = false;
    constructor(private readonly callback: ResizeObserverCallback) {
      FakeResizeObserver.instances.push(this);
    }
    observe(element: Element) {
      this.observed.push(element);
    }
    unobserve() {}
    disconnect() {
      this.disconnected = true;
    }
    fire() {
      this.callback([], this as unknown as ResizeObserver);
    }
  }
  const originalResizeObserver = global.ResizeObserver;

  // Scrolls the list the way a finger does: its scrollLeft moves, then the event.
  const scrollTo = (left: number) => {
    metrics.scrollLeft = left;
    fireEvent.scroll(list());
  };

  beforeEach(() => {
    pathname = "/shorts/BHP/strategy";
    Object.assign(metrics, { scrollLeft: 0, clientWidth: 360, scrollWidth: 760 });
    FakeResizeObserver.instances = [];
    global.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver;
    stub(HTMLElement.prototype, "scrollLeft", {
      get: () => metrics.scrollLeft,
      set: (value: number) => {
        metrics.scrollLeft = value;
      },
    });
    stub(HTMLElement.prototype, "clientWidth", { get: () => metrics.clientWidth });
    stub(HTMLElement.prototype, "scrollWidth", { get: () => metrics.scrollWidth });
    // jsdom has no Element.scrollTo; the active-tab effect may call it.
    stub(HTMLElement.prototype, "scrollTo", { value: jest.fn() });
  });
  afterEach(() => {
    for (const [target, key, original] of defined.splice(0).reverse()) {
      if (original) Object.defineProperty(target, key, original);
      else delete (target as Record<string, unknown>)[key];
    }
    global.ResizeObserver = originalResizeObserver;
  });

  it("fades the end of the list at rest, where the other tabs are", () => {
    render(<StockTabNav stockCode="BHP" />);
    expect(list()).toHaveAttribute("data-scroll-end", "true");
    expect(list()).not.toHaveAttribute("data-scroll-start");
    expect(fades()).toEqual([FADE_END]);
  });

  it("draws no cue on a bar that fits (a desktop), where there is nothing to scroll to", () => {
    metrics.clientWidth = 760;
    render(<StockTabNav stockCode="BHP" />);
    expect(list()).not.toHaveAttribute("data-scroll-end");
    expect(list()).not.toHaveAttribute("data-scroll-start");
    expect(fades()).toEqual([]);
    expect(list().className).not.toContain("mask-image");
  });

  it("fades both edges part of the way along, with tabs on either side", () => {
    render(<StockTabNav stockCode="BHP" />);
    scrollTo(120);
    expect(list()).toHaveAttribute("data-scroll-start", "true");
    expect(list()).toHaveAttribute("data-scroll-end", "true");
    expect(fades()).toEqual([FADE_BOTH]);
  });

  it("moves the fade to the start once the list has scrolled to its end", () => {
    render(<StockTabNav stockCode="BHP" />);
    scrollTo(400); // 400 + 360 = 760: the last tab is in
    expect(list()).toHaveAttribute("data-scroll-start", "true");
    expect(list()).not.toHaveAttribute("data-scroll-end");
    expect(fades()).toEqual([FADE_START]);
  });

  it("brings the end fade back when the list scrolls back from its end", () => {
    render(<StockTabNav stockCode="BHP" />);
    scrollTo(400);
    scrollTo(0);
    expect(list()).toHaveAttribute("data-scroll-end", "true");
    expect(list()).not.toHaveAttribute("data-scroll-start");
    expect(fades()).toEqual([FADE_END]);
  });

  // scrollLeft is fractional on a zoomed or high-density screen, so the end is
  // reached to within a pixel.
  it("counts the end as reached within a pixel, and not at two", () => {
    render(<StockTabNav stockCode="BHP" />);
    scrollTo(399); // 399 + 360 = 759 = scrollWidth - 1
    expect(list()).not.toHaveAttribute("data-scroll-end");
    scrollTo(398); // 758 = scrollWidth - 2
    expect(list()).toHaveAttribute("data-scroll-end", "true");
  });

  it("counts any scroll at all as having left the start", () => {
    render(<StockTabNav stockCode="BHP" />);
    scrollTo(0.5);
    expect(list()).toHaveAttribute("data-scroll-start", "true");
  });

  it("measures the list when it is shown, before anyone scrolls it", () => {
    metrics.scrollLeft = 400; // a list that mounts already at its end
    render(<StockTabNav stockCode="BHP" />);
    expect(list()).toHaveAttribute("data-scroll-start", "true");
    expect(list()).not.toHaveAttribute("data-scroll-end");
  });

  it("watches the list and every tab, so a resize or a late font re-measures it", () => {
    render(<StockTabNav stockCode="BHP" />);
    expect(FakeResizeObserver.instances).toHaveLength(1);
    const [observer] = FakeResizeObserver.instances;
    expect(observer!.observed).toContain(list());
    for (const link of screen.getAllByRole("link")) expect(observer!.observed).toContain(link);
    expect(observer!.observed).toHaveLength(8);

    // The window grows past the tabs: nothing is left to scroll to.
    metrics.clientWidth = 800;
    act(() => observer!.fire());
    expect(list()).not.toHaveAttribute("data-scroll-end");
    expect(fades()).toEqual([]);

    // And shrinks again (a rotation).
    metrics.clientWidth = 360;
    act(() => observer!.fire());
    expect(list()).toHaveAttribute("data-scroll-end", "true");
    expect(fades()).toEqual([FADE_END]);
  });

  it("stops watching when it unmounts", () => {
    const view = render(<StockTabNav stockCode="BHP" />);
    const [observer] = FakeResizeObserver.instances;
    expect(observer!.disconnected).toBe(false);
    view.unmount();
    expect(observer!.disconnected).toBe(true);
  });

  it("falls back to the window's resize where there is no ResizeObserver", () => {
    global.ResizeObserver = undefined as unknown as typeof ResizeObserver;
    const view = render(<StockTabNav stockCode="BHP" />);
    expect(list()).toHaveAttribute("data-scroll-end", "true");

    metrics.clientWidth = 800;
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    expect(list()).not.toHaveAttribute("data-scroll-end");

    view.unmount();
    metrics.clientWidth = 360;
    // Nothing is listening any more: this must not throw or warn about an
    // update on an unmounted component.
    window.dispatchEvent(new Event("resize"));
  });

  it("keeps the layout classes the list already had", () => {
    render(<StockTabNav stockCode="BHP" />);
    expect(list()).toHaveClass(
      "relative", "flex", "h-11", "scroll-px-8", "items-stretch", "gap-1", "overflow-x-auto", "px-8",
      "[scrollbar-width:none]", "[&::-webkit-scrollbar]:hidden",
    );
  });

  it("draws no cue in the server's markup, which cannot know whether the tabs overflow", () => {
    const error = jest.spyOn(console, "error").mockImplementation(() => undefined);
    const html = renderToStaticMarkup(<StockTabNav stockCode="BHP" />);
    error.mockRestore();
    // (The Link stand-in prints its own data-scroll; the cue's are -start and -end.)
    expect(html).not.toContain("data-scroll-start");
    expect(html).not.toContain("data-scroll-end");
    expect(html).not.toContain("mask-image");
  });
});
