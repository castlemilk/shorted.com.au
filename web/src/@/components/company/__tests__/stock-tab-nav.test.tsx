import { fireEvent, render, screen } from "@testing-library/react";

const prefetch = jest.fn();
let pathname = "/shorts/BHP/strategy";
jest.mock("next/navigation", () => ({
  useRouter: () => ({ prefetch, push: jest.fn(), replace: jest.fn() }),
  usePathname: () => pathname,
}));
jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ children, href, prefetch, ...rest }: { children: React.ReactNode; href: string; prefetch?: boolean }) => (
    <a href={href} data-prefetch={String(prefetch)} {...rest}>{children}</a>
  ),
}));

import { StockTabNav } from "../stock-tab-nav";

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
});
