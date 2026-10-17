import { render, screen, within } from "@testing-library/react";

// next/link with the prefetch prop surfaced as data-prefetch so a test can read it.
jest.mock("next/link", () => ({
  __esModule: true,
  default: ({
    children,
    href,
    prefetch,
    ...rest
  }: {
    children: React.ReactNode;
    href: string;
    prefetch?: boolean;
  }) => (
    <a href={href} data-prefetch={String(prefetch)} {...rest}>
      {children}
    </a>
  ),
}));

import { Breadcrumbs } from "./breadcrumbs";

const items = [
  { label: "Stocks", href: "/stocks" },
  { label: "BHP", href: "/shorts/BHP" },
  { label: "Strategy", href: "/shorts/BHP/strategy" },
];

function links() {
  return within(screen.getByRole("navigation", { name: "Breadcrumb" })).getAllByRole("link");
}

describe("Breadcrumbs prefetch", () => {
  // The component is shared by ~50 pages. Its default must stay Next's own, so
  // none of them changes behaviour; a page opts out for itself.
  it("leaves Link's own default alone unless a page asks otherwise", () => {
    render(<Breadcrumbs items={items} />);
    expect(links().map((l) => l.getAttribute("href"))).toEqual(["/", "/stocks", "/shorts/BHP"]);
    for (const link of links()) {
      expect(link).toHaveAttribute("data-prefetch", "undefined");
    }
  });

  it("turns prefetch off on the home link and every crumb when a page opts out", () => {
    render(<Breadcrumbs items={items} prefetch={false} />);
    expect(links()).toHaveLength(3);
    for (const link of links()) {
      expect(link).toHaveAttribute("data-prefetch", "false");
    }
  });

  it("passes an explicit true through", () => {
    render(<Breadcrumbs items={items} prefetch />);
    for (const link of links()) {
      expect(link).toHaveAttribute("data-prefetch", "true");
    }
  });

  it("marks the last crumb as the current page, not a link", () => {
    render(<Breadcrumbs items={items} prefetch={false} />);
    const current = screen.getByText("Strategy");
    expect(current).toHaveAttribute("aria-current", "page");
    expect(current.closest("a")).toBeNull();
  });
});
