import { render, screen, within } from "@testing-library/react";

let pathname = "/shorts/BHP";
jest.mock("next/navigation", () => ({
  usePathname: () => pathname,
}));
// next/link with the prefetch prop surfaced as data-prefetch so a test can read it.
jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ children, href, prefetch, ...rest }: { children: React.ReactNode; href: string; prefetch?: boolean }) => (
    <a href={href} data-prefetch={String(prefetch)} {...rest}>{children}</a>
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

  // The trail is on every tab and links to the stock's Overview, an ISR route.
  // Next's default prefetches a link as it scrolls into view, so each tab view
  // would prefetch (and on a cold cache generate) that Overview.
  it.each(["/shorts/BHP/strategy", "/shorts/BHP/community/thread-1"])(
    "turns Link's own prefetch off on every link of the trail at %s",
    (path) => {
      pathname = path;
      render(<StockBreadcrumbs stockCode="BHP" />);
      const links = within(screen.getByRole("navigation", { name: "Breadcrumb" })).getAllByRole("link");
      expect(links.length).toBeGreaterThanOrEqual(3);
      for (const link of links) {
        expect(link).toHaveAttribute("data-prefetch", "false");
      }
    },
  );
});
