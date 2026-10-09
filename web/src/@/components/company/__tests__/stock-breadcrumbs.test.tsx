import { render, screen, within } from "@testing-library/react";

let pathname = "/shorts/BHP";
jest.mock("next/navigation", () => ({
  usePathname: () => pathname,
}));
jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ children, href, prefetch: _p, ...rest }: { children: React.ReactNode; href: string; prefetch?: boolean }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));

import { StockBreadcrumbs } from "../stock-breadcrumbs";

function trail() {
  const nav = screen.getByRole("navigation", { name: "Breadcrumb" });
  return {
    hrefs: within(nav).getAllByRole("link").map((l) => l.getAttribute("href")),
    current: nav.querySelector('[aria-current="page"]')?.textContent,
  };
}

describe("StockBreadcrumbs", () => {
  beforeEach(() => {
    pathname = "/shorts/BHP";
  });

  it("ends at the code on the overview, with no tab crumb", () => {
    render(<StockBreadcrumbs stockCode="BHP" />);
    expect(trail()).toEqual({ hrefs: ["/", "/stocks"], current: "BHP" });
  });

  it("appends the active tab as the current page", () => {
    pathname = "/shorts/BHP/strategy";
    render(<StockBreadcrumbs stockCode="BHP" />);
    expect(trail()).toEqual({ hrefs: ["/", "/stocks", "/shorts/BHP"], current: "Strategy" });
  });

  it("keeps Community as the tab crumb on a thread page", () => {
    pathname = "/shorts/BHP/community/thread-1";
    render(<StockBreadcrumbs stockCode="BHP" />);
    expect(trail()).toEqual({ hrefs: ["/", "/stocks", "/shorts/BHP"], current: "Community" });
  });
});
