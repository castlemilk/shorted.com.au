import { fireEvent, render, screen } from "@testing-library/react";

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
      "sticky", "top-16", "z-30", "-mx-8", "px-8", "mb-4", "border-b", "border-border",
      "bg-background/90", "backdrop-blur", "supports-[backdrop-filter]:bg-background/75",
    );
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

  it("leaves the list alone when the active tab is already visible", () => {
    pathname = "/shorts/BHP";
    const scrollTo = jest.fn();
    define(HTMLElement.prototype, "scrollTo", scrollTo);
    define(HTMLElement.prototype, "clientWidth", 300);
    define(HTMLElement.prototype, "scrollLeft", 0);
    define(HTMLElement.prototype, "offsetWidth", 90);
    define(HTMLElement.prototype, "offsetLeft", 0);
    render(<StockTabNav stockCode="BHP" />);
    expect(scrollTo).not.toHaveBeenCalled();
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
