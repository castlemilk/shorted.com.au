import * as fs from "node:fs";
import * as path from "node:path";
import { render, screen, within } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { MarketMoveCard, marketMoveHref } from "../market-move-card";
import { MarketMovesStrip } from "../market-moves-strip";
import { StockMarketMoves } from "../stock-market-moves";
import { MarketMovesList } from "../market-moves-list";
import type { MarketMoveView } from "~/@/lib/market-moves/view";

// next/link with the prefetch prop surfaced as data-prefetch, as the register
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

function view(overrides: Partial<MarketMoveView> = {}): MarketMoveView {
  return {
    moveKey: "2026-11-07:bhp:iron-ore",
    kind: "stock",
    stockCode: "BHP",
    companyName: "BHP Group",
    indexCode: null,
    sector: null,
    relatedCodes: ["RIO"],
    direction: "down",
    changePct: -3.1,
    price: 45.1,
    volumeRatio: 2.1,
    headline: "BHP falls as iron ore slides",
    summary:
      "Iron ore futures fell 5% overnight.\nMiners led the market lower.",
    sources: [
      {
        title: "Iron ore slides",
        url: "https://example.com/iron",
        publisher: "Example",
      },
    ],
    tags: ["iron-ore"],
    significance: 4,
    observedAt: "2026-11-07T03:05:00Z",
    marketDate: "2026-11-07",
    revision: 1,
    publishedAt: "2026-11-07T03:06:00Z",
    updatedAt: "2026-11-07T03:06:00Z",
    model: "claude-opus-5-5",
    ...overrides,
  };
}

describe("MarketMoveCard", () => {
  it("is anchored at move-<key> so the API's URL lands on it", () => {
    const { container } = render(<MarketMoveCard move={view()} />);
    const article = container.querySelector("article");
    expect(article?.id).toBe("move-2026-11-07:bhp:iron-ore");
    expect(article?.className).toContain("scroll-mt-");
    expect(marketMoveHref("k1")).toBe("/market-moves#move-k1");
  });

  it("signs a fall with U+2212 and colours it by direction", () => {
    render(<MarketMoveCard move={view()} />);
    const change = screen.getByTestId("move-change");
    expect(change.textContent).toBe("−3.10%");
    expect(change.textContent).not.toContain("-");
    expect(change.className).toContain("text-red-600");
  });

  it("colours a rise green and keeps flat and mixed in the foreground", () => {
    const { rerender } = render(
      <MarketMoveCard move={view({ direction: "up", changePct: 4.2 })} />,
    );
    expect(screen.getByTestId("move-change").textContent).toBe("+4.20%");
    expect(screen.getByTestId("move-change").className).toContain(
      "text-green-700",
    );
    rerender(
      <MarketMoveCard move={view({ direction: "mixed", changePct: 0.3 })} />,
    );
    expect(screen.getByTestId("move-change").className).toContain(
      "text-foreground",
    );
  });

  it("leaves out a figure the poster did not give, never printing 0", () => {
    render(
      <MarketMoveCard
        move={view({
          kind: "sector",
          stockCode: null,
          companyName: null,
          sector: "Materials",
          changePct: null,
          price: null,
          volumeRatio: null,
        })}
      />,
    );
    expect(screen.getByTestId("move-change").textContent).toBe("Down");
    expect(screen.queryByTestId("move-price")).toBeNull();
    expect(screen.queryByTestId("move-volume")).toBeNull();
    expect(screen.queryByText(/0\.00%/)).toBeNull();
    expect(screen.getByText("Materials")).toBeTruthy();
  });

  it("prints the price and volume when given", () => {
    render(<MarketMoveCard move={view()} />);
    expect(screen.getByTestId("move-price").textContent).toBe("$45.10");
    expect(screen.getByTestId("move-volume").textContent).toBe(
      "2.1× usual volume",
    );
  });

  it("links the subject and related codes to their stock pages without prefetch", () => {
    render(<MarketMoveCard move={view()} />);
    const bhp = screen.getByRole("link", { name: "BHP" });
    expect(bhp.getAttribute("href")).toBe("/shorts/BHP");
    expect(bhp.getAttribute("data-prefetch")).toBe("false");
    const rio = screen.getByRole("link", { name: "RIO" });
    expect(rio.getAttribute("href")).toBe("/shorts/RIO");
    expect(rio.getAttribute("data-prefetch")).toBe("false");
  });

  it("does not link the stock page it sits on", () => {
    render(
      <MarketMoveCard move={view()} currentStockCode="BHP" variant="compact" />,
    );
    expect(screen.queryByRole("link", { name: "BHP" })).toBeNull();
    expect(screen.getByText("BHP")).toBeTruthy();
  });

  it("opens sources outside the site as nofollow, noopener, noreferrer and ugc", () => {
    render(<MarketMoveCard move={view()} />);
    const source = within(
      screen.getByRole("list", { name: "Sources" }),
    ).getByRole("link");
    expect(source.getAttribute("href")).toBe("https://example.com/iron");
    expect(source.getAttribute("target")).toBe("_blank");
    expect(source.getAttribute("rel")).toBe("nofollow noopener noreferrer ugc");
  });

  it("keeps the summary as plain text with its line breaks", () => {
    const html = renderToStaticMarkup(
      <MarketMoveCard move={view({ summary: "<b>bold</b>\nnext line" })} />,
    );
    expect(html).toContain("&lt;b&gt;bold&lt;/b&gt;");
    expect(html).toContain("whitespace-pre-line");
  });

  it("states the observation time, the revision, the AI disclosure and that it is not advice", () => {
    const { container, rerender } = render(<MarketMoveCard move={view()} />);
    const time = container.querySelector("time");
    expect(time?.getAttribute("dateTime")).toBe("2026-11-07T03:05:00Z");
    expect(time?.textContent).toBe("Observed 2:05 pm AEDT, Sat 7 Nov");
    expect(container.textContent).toContain(
      "Written by an AI market-moves workflow (claude-opus-5-5)",
    );
    expect(container.textContent).toContain("Not financial advice");
    expect(container.textContent).not.toContain("Updated");
    rerender(<MarketMoveCard move={view({ revision: 2, model: null })} />);
    expect(container.textContent).toContain("Updated");
    expect(container.textContent).toContain(
      "Written by an AI market-moves workflow ·",
    );
  });

  it("links a compact card's headline to the move on the feed and drops its sources", () => {
    render(<MarketMoveCard move={view()} variant="compact" />);
    const headline = screen.getByRole("link", {
      name: "BHP falls as iron ore slides",
    });
    expect(headline.getAttribute("href")).toBe(
      "/market-moves#move-2026-11-07:bhp:iron-ore",
    );
    expect(screen.queryByRole("list", { name: "Sources" })).toBeNull();
  });

  it("names an index and the whole market", () => {
    const { rerender } = render(
      <MarketMoveCard
        move={view({
          kind: "index",
          stockCode: null,
          companyName: null,
          indexCode: "XJO",
          price: 8512.34,
        })}
      />,
    );
    expect(screen.getByText("XJO")).toBeTruthy();
    expect(screen.getByText("S&P/ASX 200")).toBeTruthy();
    expect(screen.getByTestId("move-price").textContent).toBe("8,512.3");
    rerender(
      <MarketMoveCard
        move={view({ kind: "market", stockCode: null, companyName: null })}
      />,
    );
    expect(screen.getByText("ASX market")).toBeTruthy();
  });

  it("is a server component: no client directive, no Connect", () => {
    for (const file of [
      "market-move-card.tsx",
      "market-moves-strip.tsx",
      "stock-market-moves.tsx",
      "market-moves-list.tsx",
    ]) {
      const source = fs.readFileSync(path.join(__dirname, "..", file), "utf8");
      expect(source).not.toMatch(/^["']use client["']/m);
      expect(source).not.toMatch(/@connectrpc|@bufbuild/);
      expect(source).not.toMatch(/from "~\/gen\//);
    }
  });
});

describe("MarketMovesStrip", () => {
  it("renders nothing when there are no moves", () => {
    expect(renderToStaticMarkup(<MarketMovesStrip moves={[]} />)).toBe("");
  });

  it("draws the moves and links to the feed", () => {
    render(<MarketMovesStrip moves={[view(), view({ moveKey: "k2" })]} />);
    expect(screen.getByRole("heading", { name: "Market moves" })).toBeTruthy();
    expect(
      screen
        .getByRole("link", { name: /All market moves/ })
        .getAttribute("href"),
    ).toBe("/market-moves");
    expect(document.querySelectorAll("article")).toHaveLength(2);
  });
});

describe("StockMarketMoves", () => {
  it("renders nothing when the stock has no moves", () => {
    expect(
      renderToStaticMarkup(<StockMarketMoves stockCode="BHP" moves={[]} />),
    ).toBe("");
  });

  it("draws the stock's moves under its own heading", () => {
    render(<StockMarketMoves stockCode="bhp" moves={[view()]} />);
    expect(screen.getByRole("heading", { name: "Market moves" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "BHP" })).toBeNull();
  });
});

describe("MarketMovesList", () => {
  it("renders nothing for no moves and one card per move otherwise", () => {
    expect(renderToStaticMarkup(<MarketMovesList moves={[]} />)).toBe("");
    render(<MarketMovesList moves={[view(), view({ moveKey: "k2" })]} />);
    expect(document.querySelectorAll("article")).toHaveLength(2);
  });
});
