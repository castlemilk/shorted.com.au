import { fireEvent, render, screen } from "@testing-library/react";

const prefetch = jest.fn();
let pathname = "/strategies/canslim";
jest.mock("next/navigation", () => ({
  useRouter: () => ({ prefetch, push: jest.fn(), replace: jest.fn() }),
  usePathname: () => pathname,
}));
// Like Next's Link: the link's own onClick runs first, then the click is taken
// over (so jsdom never tries to navigate). `scroll` and `prefetch` are exposed.
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
// Three tabs enabled, so the bar has a tab to prefetch and a tab to leave alone. The
// registry itself lists the Overview only; its own tests cover that.
jest.mock("~/@/lib/strategies/strategy-tabs", () => {
  const actual = jest.requireActual("~/@/lib/strategies/strategy-tabs");
  return {
    ...actual,
    enabledStrategyTabs: () => [
      { id: "overview", label: "Overview", segment: "", enabled: true },
      { id: "rules", label: "Rules", segment: "rules", enabled: true },
      { id: "backtest", label: "Backtest", segment: "backtest", enabled: true },
    ],
  };
});

import { StrategyTabNav } from "../strategy-tab-nav";

const navigation = () => screen.getByRole("navigation", { name: "Strategy sections" });

describe("StrategyTabNav", () => {
  beforeEach(() => {
    prefetch.mockClear();
    pathname = "/strategies/canslim";
  });

  it("renders the enabled tabs in order, with the strategy's own hrefs", () => {
    render(<StrategyTabNav slug="canslim" />);
    const links = screen.getAllByRole("link");
    expect(links.map((l) => l.getAttribute("href"))).toEqual([
      "/strategies/canslim",
      "/strategies/canslim/rules",
      "/strategies/canslim/backtest",
    ]);
  });

  it("marks the Overview active on the bare strategy URL", () => {
    render(<StrategyTabNav slug="canslim" />);
    expect(screen.getByRole("link", { name: "Overview" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Rules" })).not.toHaveAttribute("aria-current");
  });

  it("marks the tab its pathname is on", () => {
    pathname = "/strategies/canslim/rules";
    render(<StrategyTabNav slug="canslim" />);
    expect(screen.getByRole("link", { name: "Rules" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Overview" })).not.toHaveAttribute("aria-current");
  });

  it("turns off Link's own prefetch and scroll on every tab, so the bar decides both", () => {
    render(<StrategyTabNav slug="canslim" />);
    for (const link of screen.getAllByRole("link")) {
      expect(link).toHaveAttribute("data-prefetch", "false");
      expect(link).toHaveAttribute("data-scroll", "false");
    }
  });

  // Each trigger is pinned on its own, so a missing handler cannot hide behind another.
  const triggers: [string, typeof fireEvent.pointerEnter][] = [
    ["pointer enter", fireEvent.pointerEnter],
    ["touch start", fireEvent.touchStart],
    ["focus", fireEvent.focus],
  ];
  it.each(triggers)("prefetches a tab that is not open on %s alone, once", (_name, fire) => {
    render(<StrategyTabNav slug="canslim" />);
    fire(screen.getByRole("link", { name: "Rules" }));
    expect(prefetch).toHaveBeenCalledTimes(1);
    expect(prefetch).toHaveBeenCalledWith("/strategies/canslim/rules");
  });

  it("warms each href once however often the visitor shows intent", () => {
    render(<StrategyTabNav slug="canslim" />);
    const rules = screen.getByRole("link", { name: "Rules" });
    fireEvent.pointerEnter(rules);
    fireEvent.focus(rules);
    fireEvent.touchStart(rules);
    fireEvent.pointerEnter(rules);
    expect(prefetch).toHaveBeenCalledTimes(1);
  });

  it("never prefetches the tab the page is already on", () => {
    render(<StrategyTabNav slug="canslim" />);
    const overview = screen.getByRole("link", { name: "Overview" });
    fireEvent.pointerEnter(overview);
    fireEvent.touchStart(overview);
    fireEvent.focus(overview);
    expect(prefetch).not.toHaveBeenCalled();
  });

  it("sits under the site header, translucent and bleeding to the edges of main", () => {
    render(<StrategyTabNav slug="canslim" />);
    expect(navigation()).toHaveClass(
      "sticky", "top-16", "z-30", "-mx-8", "mb-4", "border-b", "border-border",
      "bg-background/90", "backdrop-blur",
    );
    expect(navigation()).not.toHaveClass("px-8");
    expect(navigation().firstElementChild).toHaveClass("px-8", "scroll-px-8", "overflow-x-auto");
  });

  it("puts a zero-height sentinel in the flow just before the bar, hidden from assistive technology", () => {
    render(<StrategyTabNav slug="canslim" />);
    const sentinel = navigation().previousElementSibling;
    expect(sentinel).toHaveAttribute("aria-hidden", "true");
    expect(sentinel).toHaveClass("h-0");
    expect(sentinel).toBeEmptyDOMElement();
  });

  it("draws the active tab in foreground weight with an underline, and the others muted", () => {
    pathname = "/strategies/canslim/backtest";
    render(<StrategyTabNav slug="canslim" />);
    const active = screen.getByRole("link", { name: "Backtest" });
    expect(active).toHaveClass("font-semibold", "text-foreground");
    expect(active.querySelector("span")).toHaveClass("absolute", "inset-x-0", "bottom-0", "h-0.5", "bg-primary");
    const muted = screen.getByRole("link", { name: "Rules" });
    expect(muted).toHaveClass("text-muted-foreground", "hover:text-foreground");
    expect(muted).not.toHaveClass("font-semibold");
    expect(muted.querySelector("span")).toBeNull();
  });

  it("names each tab by its label alone, and draws a focus ring inside each link", () => {
    render(<StrategyTabNav slug="canslim" />);
    expect(screen.getByRole("link", { name: "Rules" })).toHaveTextContent(/^Rules$/);
    for (const link of screen.getAllByRole("link")) {
      expect(link).toHaveClass("focus-visible:ring-2", "focus-visible:ring-inset", "focus-visible:ring-ring");
    }
  });
});

describe("StrategyTabNav scroll on a tab switch", () => {
  // The bar's place in the document is where the sentinel sits. With the bar
  // docked at top-16 (64px), the page scrolls to DOCK_Y to put the bar there.
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
    jest
      .spyOn(navigation().previousElementSibling as Element, "getBoundingClientRect")
      .mockImplementation(() => ({ top: SENTINEL_DOCUMENT_TOP - window.scrollY }) as DOMRect);
  };
  const mountAt = (initialPath: string) => {
    pathname = initialPath;
    const view = render(<StrategyTabNav slug="canslim" />);
    placeSentinel();
    return {
      goTo: (nextPath: string) => {
        pathname = nextPath;
        view.rerender(<StrategyTabNav slug="canslim" />);
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
    mountAt("/strategies/canslim");
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("scrolls a docked page to exactly where the bar docks, after a click on a tab", () => {
    const { goTo } = mountAt("/strategies/canslim");
    setScroll(0, 900);
    fireEvent.click(screen.getByRole("link", { name: "Rules" }));
    // The click only arms it: nothing moves until the tab itself changes.
    expect(scrollTo).not.toHaveBeenCalled();
    goTo("/strategies/canslim/rules");
    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(scrollTo).toHaveBeenCalledWith({ top: DOCK_Y, left: 0 });
  });

  it("leaves a page alone when the bar was not docked", () => {
    const { goTo } = mountAt("/strategies/canslim");
    setScroll(0, 100);
    fireEvent.click(screen.getByRole("link", { name: "Rules" }));
    goTo("/strategies/canslim/rules");
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("does not move the page on back or forward, which change the tab without a click", () => {
    const { goTo } = mountAt("/strategies/canslim");
    setScroll(0, 900);
    goTo("/strategies/canslim/rules");
    goTo("/strategies/canslim");
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("spends the click on one switch: a later change of tab without one does not move the page", () => {
    const { goTo } = mountAt("/strategies/canslim");
    setScroll(0, 900);
    fireEvent.click(screen.getByRole("link", { name: "Rules" }));
    goTo("/strategies/canslim/rules");
    expect(scrollTo).toHaveBeenCalledTimes(1);
    goTo("/strategies/canslim");
    expect(scrollTo).toHaveBeenCalledTimes(1);
  });

  it("does not count a click on the tab that is already open", () => {
    const { goTo } = mountAt("/strategies/canslim");
    setScroll(0, 900);
    fireEvent.click(screen.getByRole("link", { name: "Overview" }));
    goTo("/strategies/canslim/rules");
    expect(scrollTo).not.toHaveBeenCalled();
  });
});
