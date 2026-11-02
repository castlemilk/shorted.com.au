import * as fs from "node:fs";
import * as path from "node:path";
import { render, screen, within } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { RegisterStrip } from "../register-strip";
import type { StockRegisterStrip } from "~/app/actions/getStockRegisterStrip";

// next/link with the prefetch prop surfaced as data-prefetch, as the strategy
// strip's test does, so a test can say which links prefetch.
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

const strip: StockRegisterStrip = {
  stockCode: "BHP",
  holders: 3,
  interests: 4,
  disclosed: "18.40%",
  indexPct: "4.25",
  indexAsAtFrom: "2026-09-01",
  indexAsAtTo: "2026-09-30",
  asOf: "2026-10-16",
  rows: [
    {
      name: "Vanguard Group",
      href: "/ownership/vanguard",
      kind: "index_manager",
      votingPower: "6.12%",
      asAt: "2026-10-02",
      age: "",
    },
    {
      name: "Citigroup",
      href: "/ownership/citigroup",
      kind: "bank_broker",
      votingPower: "5.40%",
      asAt: "2025-03-12",
      age: "19 mo",
    },
    {
      name: "Unlisted Holder",
      href: null,
      kind: "other",
      votingPower: "5.10%",
      asAt: "2026-06-04",
      age: "",
    },
  ],
};

const SUMMARY =
  "3 holders, 4 interests counted once, disclose 18.40% between them; largest: " +
  "Vanguard Group 6.12%, Citigroup 5.40% as at 2025-03-12 (19 mo), Unlisted Holder 5.10%; " +
  "index funds tracked hold 4.25% of shares on issue (files as at 2026-09-01 to 2026-09-30)";

function summaryOf(region: HTMLElement): HTMLElement {
  return within(region).getByText(/interests counted once/);
}

describe("RegisterStrip", () => {
  it("is a region named for its title, and says whose holders it describes", () => {
    render(<RegisterStrip strip={strip} />);
    const region = screen.getByRole("region", { name: "Substantial holders" });
    expect(within(region).getByText("Who holds BHP, as its notices state it")).toBeInTheDocument();
  });

  it("states the holders, the interests, the disclosed sum and the index clause in one line", () => {
    render(<RegisterStrip strip={strip} />);
    const region = screen.getByRole("region", { name: "Substantial holders" });
    expect(summaryOf(region).textContent).toBe(SUMMARY);
  });

  it("names at most three holders, however many it is given", () => {
    render(
      <RegisterStrip
        strip={{
          ...strip,
          holders: 4,
          rows: [
            ...strip.rows,
            { name: "Fourth Holder", href: null, kind: "other", votingPower: "2.00%", asAt: "2026-07-01", age: "" },
          ],
        }}
      />,
    );
    const region = screen.getByRole("region", { name: "Substantial holders" });
    expect(summaryOf(region).textContent).toContain("Unlisted Holder 5.10%");
    expect(summaryOf(region).textContent).not.toContain("Fourth Holder");
  });

  it("links a holder that has a page, and prints the rest as plain text", () => {
    render(<RegisterStrip strip={strip} />);
    const region = screen.getByRole("region", { name: "Substantial holders" });
    const vanguard = within(region).getByRole("link", { name: "Vanguard Group" });
    expect(vanguard).toHaveAttribute("href", "/ownership/vanguard");
    expect(vanguard).toHaveAttribute("data-prefetch", "false");
    expect(within(region).getByRole("link", { name: "Citigroup" })).toHaveAttribute(
      "href",
      "/ownership/citigroup",
    );
    expect(within(region).queryByRole("link", { name: "Unlisted Holder" })).not.toBeInTheDocument();
  });

  it("carries the notice date only on a holding older than the age rule, as a machine-readable date", () => {
    const { container } = render(<RegisterStrip strip={strip} />);
    const region = screen.getByRole("region", { name: "Substantial holders" });
    expect(summaryOf(region).textContent).not.toContain("as at 2026-10-02");
    expect(container.querySelector('time[datetime="2025-03-12"]')).toHaveTextContent("2025-03-12");
  });

  it("sets every date it prints as a time element", () => {
    const { container } = render(<RegisterStrip strip={strip} />);
    for (const date of ["2025-03-12", "2026-10-16", "2026-09-01", "2026-09-30"]) {
      expect(container.querySelector(`time[datetime="${date}"]`)).not.toBeNull();
    }
  });

  it("leaves the index clause out when no index figure is held", () => {
    render(<RegisterStrip strip={{ ...strip, indexPct: null }} />);
    const region = screen.getByRole("region", { name: "Substantial holders" });
    expect(summaryOf(region).textContent).not.toContain("index funds tracked");
    expect(summaryOf(region).textContent).not.toContain("shares on issue");
  });

  it("ends with the register link, the disclaimer and a report link addressed to the register", () => {
    render(<RegisterStrip strip={strip} />);
    const region = screen.getByRole("region", { name: "Substantial holders" });
    const register = within(region).getByRole("link", { name: "Full register →" });
    expect(register).toHaveAttribute("href", "/ownership/stocks/BHP");
    expect(register).toHaveAttribute("data-prefetch", "false");
    expect(within(region).getByRole("link", { name: "Not financial advice" })).toHaveAttribute(
      "href",
      "/disclaimer",
    );
    expect(within(region).getByRole("link", { name: "Report an error" })).toHaveAttribute(
      "href",
      "mailto:support@shorted.com.au?subject=Ownership%20data%3A%20BHP%20register",
    );
  });

  it("says which date the notices were read to, and what the figures are not", () => {
    render(<RegisterStrip strip={strip} />);
    const region = screen.getByRole("region", { name: "Substantial holders" });
    expect(region.textContent).toContain(
      "Notices read to 2026-10-16 · what the notices disclose, not a share of the company · Not financial advice · Report an error",
    );
  });

  it("prints no zero and no n/a in its figures", () => {
    render(<RegisterStrip strip={strip} />);
    const region = screen.getByRole("region", { name: "Substantial holders" });
    expect(region.textContent).not.toMatch(/n\/a/);
    expect(region.textContent).not.toMatch(/(?<![\d.])0(\.0+)?%/);
  });

  it("draws nothing when no holder is named", () => {
    const { container } = render(<RegisterStrip strip={{ ...strip, rows: [] }} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders on the server, with no client module and no retired wording", () => {
    const html = renderToStaticMarkup(<RegisterStrip strip={strip} />);
    expect(html).toContain("Substantial holders");
    // A regex literal: the editorial-copy guard decodes string escapes.
    expect(html).not.toMatch(/\u2014/);
    expect(html).not.toMatch(/of the voting power|'s voting power|\bsold\b|\bsale\b|index ETF/);

    const source = fs.readFileSync(path.resolve(__dirname, "../register-strip.tsx"), "utf8");
    expect(source).not.toMatch(/"use client"/);
    expect(source).not.toMatch(/@connectrpc|\/gen\//);
  });
});
