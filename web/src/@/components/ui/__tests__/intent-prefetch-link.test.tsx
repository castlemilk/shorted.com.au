import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { IntentPrefetchLink } from "../intent-prefetch-link";
import { MoversCard } from "~/app/top/components/movers-card";

const mockRouter = {
  push: jest.fn(), replace: jest.fn(), back: jest.fn(), forward: jest.fn(),
  refresh: jest.fn(), prefetch: jest.fn(),
};
jest.mock("next/navigation", () => ({ useRouter: () => mockRouter }));

function link(href = "/shorts/BHP") {
  return <IntentPrefetchLink href={href} className="stock-link">BHP Group</IntentPrefetchLink>;
}

function mount(children: React.ReactNode) {
  return render(<AppRouterContext.Provider value={mockRouter}>{children}</AppRouterContext.Provider>);
}

function advance(milliseconds = 150) {
  act(() => { jest.advanceTimersByTime(milliseconds); });
}

describe("stock link intent prefetch", () => {
  beforeEach(() => { jest.useFakeTimers(); jest.clearAllMocks(); });
  afterEach(() => { cleanup(); jest.useRealTimers(); });

  it("does not prefetch 115 visible stock links under Next's production viewport observer", () => {
    const originalNodeEnv = process.env.NODE_ENV;
    let intersect: IntersectionObserverCallback | undefined;
    jest.mocked(global.IntersectionObserver).mockImplementationOnce((callback) => {
      intersect = callback;
      return {
        observe: jest.fn(), unobserve: jest.fn(), disconnect: jest.fn(),
      } as unknown as IntersectionObserver;
    });
    process.env.NODE_ENV = "production";
    try {
      mount(<>{Array.from({ length: 115 }, (_, index) => (
        <IntentPrefetchLink key={index} href={`/shorts/STOCK${index}`}>Stock {index}</IntentPrefetchLink>
      ))}</>);
      const stocks = screen.getAllByRole("link");
      expect(stocks).toHaveLength(115);
      expect(intersect).toBeDefined();
      act(() => {
        intersect!(stocks.map((target) => ({ target, isIntersecting: true })) as IntersectionObserverEntry[], {} as IntersectionObserver);
      });
      advance(1000);
      expect(mockRouter.prefetch).not.toHaveBeenCalled();
    } finally {
      process.env.NODE_ENV = originalNodeEnv;
    }
  });

  it("renders normal links without prefetching on mount or brief pointer passes", () => {
    mount(<>{link()}{link("/shorts/CBA")}</>);
    const stock = screen.getAllByRole("link")[0]!;
    expect(stock).toHaveAttribute("href", "/shorts/BHP");
    expect(stock).toHaveClass("stock-link");
    advance(1000);
    expect(mockRouter.prefetch).not.toHaveBeenCalled();

    fireEvent.pointerEnter(stock);
    // Next Link also receives mouseenter; prefetch=false must disable its immediate fetch.
    fireEvent.mouseEnter(stock);
    advance(149);
    expect(mockRouter.prefetch).not.toHaveBeenCalled();
    fireEvent.pointerLeave(stock);
    advance(1000);
    expect(mockRouter.prefetch).not.toHaveBeenCalled();
  });

  it("prefetches once after sustained keyboard focus, including subsequent hover", () => {
    mount(link());
    const stock = screen.getByRole("link", { name: "BHP Group" });
    fireEvent.focus(stock);
    advance(149);
    expect(mockRouter.prefetch).not.toHaveBeenCalled();
    advance(1);
    expect(mockRouter.prefetch).toHaveBeenCalledWith("/shorts/BHP");
    fireEvent.blur(stock);
    fireEvent.focus(stock);
    fireEvent.pointerEnter(stock);
    advance(1000);
    expect(mockRouter.prefetch).toHaveBeenCalledTimes(1);
  });

  it("prefetches sustained hover and keeps keyboard intent when the pointer leaves", () => {
    mount(<>{link()}{link("/shorts/CBA")}</>);
    const [first, second] = screen.getAllByRole("link");
    fireEvent.pointerEnter(first!);
    advance();
    expect(mockRouter.prefetch).toHaveBeenCalledWith("/shorts/BHP");

    fireEvent.pointerEnter(second!);
    fireEvent.focus(second!);
    fireEvent.pointerLeave(second!);
    advance();
    expect(mockRouter.prefetch).toHaveBeenCalledWith("/shorts/CBA");
    expect(mockRouter.prefetch).toHaveBeenCalledTimes(2);
  });

  it("cancels pending focus prefetch on blur, unmount, and href changes", () => {
    const view = mount(link());
    const stock = screen.getByRole("link");
    fireEvent.focus(stock);
    fireEvent.blur(stock);
    advance();
    expect(mockRouter.prefetch).not.toHaveBeenCalled();

    fireEvent.pointerEnter(stock);
    view.rerender(<AppRouterContext.Provider value={mockRouter}>{link("/shorts/CBA")}</AppRouterContext.Provider>);
    advance();
    expect(mockRouter.prefetch).not.toHaveBeenCalled();

    fireEvent.focus(screen.getByRole("link"));
    view.unmount();
    advance();
    expect(mockRouter.prefetch).not.toHaveBeenCalled();
  });

  it("preserves modified-click navigation and caller handlers", () => {
    const onClick = jest.fn();
    mount(<IntentPrefetchLink href="/shorts/BHP" onClick={onClick}>BHP Group</IntentPrefetchLink>);
    const event = new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true });
    fireEvent(screen.getByRole("link"), event);
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(false);
    expect(mockRouter.push).not.toHaveBeenCalled();
    expect(mockRouter.prefetch).not.toHaveBeenCalled();
  });

  it("does not eagerly prefetch mover links and warms only the focused stock", () => {
    mount(<MoversCard title="Rising shorts" subtitle="Weekly changes" type="gainers" items={[
      { productCode: "BHP", name: "BHP Group", latestShortPosition: 1, change: 0.5 },
      { productCode: "CBA", name: "Commonwealth Bank", latestShortPosition: 2, change: 0.2 },
    ]} />);
    advance(1000);
    expect(mockRouter.prefetch).not.toHaveBeenCalled();
    const stocks = screen.getAllByRole("link");
    expect(stocks.map((stock) => stock.getAttribute("href"))).toEqual(["/shorts/BHP", "/shorts/CBA"]);
    fireEvent.focus(stocks[1]!);
    advance();
    expect(mockRouter.prefetch).toHaveBeenCalledTimes(1);
    expect(mockRouter.prefetch).toHaveBeenCalledWith("/shorts/CBA");
  });
});
