/// <reference types="jest" />
import "@testing-library/jest-dom";

/**
 * The stock Overview's own blocks (spec D4, "Overview order"): the chart first,
 * then the About card (the company's description, the short-interest prose, the
 * themes), then the sign-in slot, then the grid the page already had; and the
 * crawler's h1 and structured data ahead of all of it.
 *
 * The real page.tsx is rendered. The About card's prose is the real
 * ShortInterestSummary; the chart panel (a client-only Connect island) and the
 * sources the card reads (company details, the short-interest series) are
 * stand-ins that show what the page handed them. Everything else on the page is
 * stubbed in overview-page-mocks.tsx. How the page behaves against an older API
 * is page-old-api.test.tsx's.
 */

import * as fs from "fs";
import * as path from "path";
import { render, screen, within } from "@testing-library/react";
import {
  mockGetStockFundamentals,
  mockGetStockStrategyFit,
  mockListStrategies,
} from "./overview-page-mocks";

// The page loads one island, the chart panel. The stand-in shows what the page
// handed it (the panel itself is a client-only Connect island).
jest.mock("next/dynamic", () => () => (props: {
  stockCode: string;
  prefsKey?: string;
  defaultView?: string;
  height?: number;
}) => (
  <div
    data-testid="chart-panel"
    data-code={props.stockCode}
    data-prefs-key={props.prefsKey}
    data-default-view={props.defaultView}
    data-height={props.height === undefined ? "css" : String(props.height)}
  />
));
// The About card's prose is the real component; only its reader is mocked.
jest.mock("../short-interest-summary", () => ({
  ...jest.requireActual<typeof import("../short-interest-summary")>(
    "../short-interest-summary",
  ),
  getShortInterestDeltas: jest.fn(async () => ({
    change7d: null,
    change30d: 0.42,
    change90d: null,
    peakPct: null,
    peakDate: null,
  })),
}));
// The About card's description. The real action reads through the edge and the
// data cache; here it answers with a company that has both summaries.
jest.mock("~/app/actions/getStockDetails", () => ({
  getStockDetails: jest.fn(async () => ({
    productCode: "BHP",
    companyName: "BHP GROUP LIMITED",
    enhancedSummary: "BHP is the world's largest listed miner, with iron ore, copper and coal.",
    summary: "BHP Group is a resources company.",
    enrichmentStatus: "completed",
  })),
}));
jest.mock("~/@/components/ui/login-prompt-banner", () => ({
  LoginPromptBanner: () => <div data-testid="login-banner" />,
}));
jest.mock("~/@/components/ui/session-gates", () => ({
  SignedOutOnly: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="signed-out-only">{children}</div>
  ),
}));
jest.mock("~/@/components/themes/theme-chips", () => ({
  StockThemeChips: ({ stockCode, className }: { stockCode: string; className?: string }) => (
    <nav data-testid="theme-chips" data-code={stockCode} className={className} />
  ),
}));

import Page from "../page";

describe("the stock Overview's own blocks: the chart, the About card and the sign-in slot", () => {
  beforeEach(() => {
    mockGetStockFundamentals.mockReset();
    mockGetStockStrategyFit.mockReset();
    mockListStrategies.mockReset();
    jest.spyOn(console, "warn").mockImplementation(() => undefined);
    jest.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const mockDetails = () =>
    jest.requireMock<{ getStockDetails: jest.Mock }>("~/app/actions/getStockDetails")
      .getStockDetails;
  const mockDeltas = () =>
    jest.requireMock<{ getShortInterestDeltas: jest.Mock }>("../short-interest-summary")
      .getShortInterestDeltas;

  async function renderOverview(stockCode = "bhp") {
    // The page reads fundamentals and the strategy fit beside the blocks under
    // test. Neither is what these tests are about, so both reads fail, which the
    // page tolerates (page-old-api.test.tsx holds that).
    mockGetStockFundamentals.mockRejectedValue(new Error("unavailable"));
    mockGetStockStrategyFit.mockRejectedValue(new Error("unavailable"));
    mockListStrategies.mockRejectedValue(new Error("unavailable"));
    return render(await Page({ params: Promise.resolve({ stockCode }) }));
  }
  const aboutCard = () => screen.getByRole("region", { name: "About BHP Group" });

  it("opens on the chart, set up for this tab: its own settings key, the combined view, a CSS-sized box", async () => {
    await renderOverview();
    const chart = screen.getByRole("region", { name: "Price & short interest" });
    expect(chart).toHaveClass("mb-4", "min-w-0");
    expect(within(chart).getByRole("heading", { level: 2 })).toHaveAttribute(
      "id",
      "stock-chart-heading",
    );
    const panel = within(chart).getByTestId("chart-panel");
    expect(panel).toHaveAttribute("data-code", "BHP");
    expect(panel).toHaveAttribute("data-prefs-key", "BHP:overview");
    expect(panel).toHaveAttribute("data-default-view", "combined");
    // No height prop: the box is 360px on a phone and 420px from sm, from CSS.
    expect(panel).toHaveAttribute("data-height", "css");
  });

  it("lays the blocks out in order: crawler summary, chart, About card, sign-in slot, then the grid", async () => {
    const { container } = await renderOverview();
    const blocks = [
      container.querySelector("section.sr-only"),
      container.querySelector("#stock-chart-heading"),
      container.querySelector("#overview-about-heading"),
      container.querySelector(".login-slot"),
      container.querySelector("#overview-short-interest-heading"),
    ];
    blocks.forEach((block) => expect(block).not.toBeNull());
    for (let i = 0; i < blocks.length - 1; i++) {
      expect(
        blocks[i]!.compareDocumentPosition(blocks[i + 1]!) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    }
  });

  it("keeps the crawler's h1 and structured data ahead of everything it shows", async () => {
    const { container } = await renderOverview();
    const first = Array.from(container.children).slice(0, 3);
    expect(first.map((el) => el.tagName)).toEqual(["SCRIPT", "SCRIPT", "SECTION"]);
    expect(first[2]).toHaveClass("sr-only");
    expect(within(first[2] as HTMLElement).getByRole("heading", { level: 1 })).toHaveTextContent(
      "BHP Group (BHP) Short Interest",
    );
  });

  it("renders an About card with the company's description, a way to the Company tab, the prose and the themes", async () => {
    await renderOverview();
    const card = aboutCard();
    expect(card).toHaveClass("mb-4", "rounded-lg", "border", "bg-card", "px-4", "py-3");
    expect(within(card).getByRole("heading", { level: 2 })).toHaveTextContent("About BHP Group");

    // The enriched summary, clamped to three lines.
    const description = within(card).getByText(/world's largest listed miner/);
    expect(description.tagName).toBe("P");
    expect(description).toHaveClass("mt-1", "line-clamp-3", "text-sm", "text-foreground");
    expect(within(card).queryByText(/BHP Group is a resources company/)).not.toBeInTheDocument();

    expect(within(card).getByRole("link", { name: "Company profile →" })).toHaveAttribute(
      "href",
      "/shorts/BHP/company",
    );

    // The short-interest prose, in the card and without a card of its own.
    const prose = within(card).getByRole("region", { name: "BHP short interest summary" });
    expect(prose).not.toHaveAttribute("class");
    expect(prose).toHaveTextContent(
      "BHP Group (ASX:BHP) has 1.20% of its shares on issue reported as short positions in the latest ASIC report, or about 60,000,000 shares.",
    );
    expect(prose).toHaveTextContent(
      "Over the past 30 days that figure has risen 0.42 percentage points.",
    );
    expect(prose).toHaveTextContent("BHP is classified in the Materials industry.");

    const chips = within(card).getByTestId("theme-chips");
    expect(chips).toHaveAttribute("data-code", "BHP");
    expect(chips).toHaveClass("mt-3");
  });

  // The ASX writes "Not Applic" in the industry field of an ETF or a trust, and
  // "Class Pend" while a classification is pending. Neither is an industry, so
  // no sentence names one and the meta tags are left empty, as for none at all.
  it.each(["Not Applic", "Class Pend"])(
    "names no industry anywhere on the page for the placeholder %p",
    async (industry) => {
      const getStock = jest.requireMock<{ getStockOrNotFound: jest.Mock }>(
        "~/app/actions/getStock",
      ).getStockOrNotFound;
      const llmMeta = jest.requireMock<{ StockLLMMeta: jest.Mock }>(
        "~/@/components/seo/llm-meta",
      ).StockLLMMeta;
      const bhp = (await getStock.getMockImplementation()!("BHP")) as Record<string, unknown>;

      // A real industry is named in all three places...
      llmMeta.mockClear();
      const real = await renderOverview();
      expect(real.container.querySelector("section.sr-only")).toHaveTextContent(
        "BHP Group operates in the Materials industry.",
      );
      expect(aboutCard()).toHaveTextContent("BHP is classified in the Materials industry.");
      expect(llmMeta.mock.calls.at(-1)?.[0]).toMatchObject({ industry: "Materials", sector: "Materials" });
      real.unmount();

      // ...and the placeholder in none of them.
      getStock.mockResolvedValueOnce({ ...bhp, industry });
      llmMeta.mockClear();
      const { container } = await renderOverview();
      const crawler = container.querySelector("section.sr-only");
      expect(crawler).toHaveTextContent("BHP Group (ASX:BHP) had 1.20% of shares");
      expect(crawler).not.toHaveTextContent("operates in");
      expect(aboutCard()).toHaveTextContent("BHP Group (ASX:BHP) has 1.20% of its shares");
      expect(aboutCard()).not.toHaveTextContent("classified in");
      expect(container).not.toHaveTextContent(industry);
      expect(llmMeta.mock.calls.at(-1)?.[0]).toMatchObject({ industry: "", sector: "" });
    },
  );

  // ANT, 164 shares short: the crawler summary said "had 0.00%", the About
  // card "has 0.00%" and the Dataset `value: 0`, each a measured zero for a
  // reported position. The title states no level for it (page-metadata.test).
  it("never prints a position that rounds to zero as 0.00%, nor states it in the Dataset", async () => {
    const getStock = jest.requireMock<{ getStockOrNotFound: jest.Mock }>(
      "~/app/actions/getStock",
    ).getStockOrNotFound;
    const bhp = (await getStock.getMockImplementation()!("BHP")) as Record<string, unknown>;
    getStock.mockResolvedValueOnce({ ...bhp, percentageShorted: 0.0000205, reportedShortPositions: 164 });

    const { container } = await renderOverview();

    expect(container.querySelector("section.sr-only")).toHaveTextContent(
      "BHP Group (ASX:BHP) had <0.01% of shares reported as short positions",
    );
    expect(aboutCard()).toHaveTextContent("BHP Group (ASX:BHP) has <0.01% of its shares on issue");
    expect(container).not.toHaveTextContent("0.00%");
    const dataset = Array.from(container.querySelectorAll('script[type="application/ld+json"]'))
      .map((script) => JSON.parse(script.innerHTML) as Record<string, unknown>)
      .find((json) => json["@type"] === "Dataset");
    const measured = (dataset?.variableMeasured ?? []) as Array<Record<string, unknown>>;
    expect(measured.find((v) => v.name === "percentShort")).not.toHaveProperty("value");
    expect(measured.find((v) => v.name === "reportedShortPositions")).toMatchObject({ value: 164 });
  });

  it("leaves the short-interest sentences that need a move out when the series has none", async () => {
    mockDeltas().mockResolvedValueOnce({
      change7d: null,
      change30d: null,
      change90d: null,
      peakPct: null,
      peakDate: null,
    });
    await renderOverview();
    const prose = within(aboutCard()).getByRole("region", { name: "BHP short interest summary" });
    expect(prose).toHaveTextContent("has 1.20% of its shares on issue");
    expect(prose).not.toHaveTextContent("Over the past");
  });

  it("falls back to the plain summary when there is no enriched one", async () => {
    mockDetails().mockResolvedValueOnce({
      companyName: "BHP GROUP LIMITED",
      enhancedSummary: "",
      summary: "BHP Group is a resources company.",
    });
    await renderOverview();
    expect(within(aboutCard()).getByText("BHP Group is a resources company.")).toHaveClass(
      "line-clamp-3",
    );
  });

  it.each([
    ["no summary of either kind", { enhancedSummary: "", summary: "" }],
    ["whitespace for a summary", { enhancedSummary: "  ", summary: "\n" }],
    ["no details at all", undefined],
    ["null details", null],
  ])("leaves the description out, and keeps the rest of the card, with %s", async (_name, details) => {
    mockDetails().mockResolvedValueOnce(details);
    await renderOverview();
    const card = aboutCard();
    expect(card.querySelector("p.line-clamp-3")).toBeNull();
    expect(within(card).getByRole("link", { name: "Company profile →" })).toBeInTheDocument();
    expect(
      within(card).getByRole("region", { name: "BHP short interest summary" }),
    ).toBeInTheDocument();
  });

  it("does not fail the render when the details read throws", async () => {
    mockDetails().mockRejectedValueOnce(new Error("details down"));
    await renderOverview();
    const card = aboutCard();
    expect(card.querySelector("p.line-clamp-3")).toBeNull();
    expect(within(card).getByRole("link", { name: "Company profile →" })).toBeInTheDocument();
  });

  it("moves the sign-in slot here from the layout, inside the gate and the slot's frame", async () => {
    const { container } = await renderOverview();
    const slot = container.querySelector(".login-slot") as HTMLElement;
    expect(slot).not.toBeNull();
    const gate = within(slot).getByTestId("signed-out-only");
    const frame = gate.firstElementChild as HTMLElement;
    expect(frame).toHaveClass("overflow-hidden", "rounded-lg", "border", "border-primary/20");
    // A dismissed banner renders null: the bare frame must not stay behind as a
    // 2px sliver of border (login-prompt-banner.test.tsx holds that the banner
    // leaves it empty).
    expect(frame).toHaveClass("empty:hidden");
    expect(within(frame).getByTestId("login-banner")).toBeInTheDocument();
    // One banner on the page: the dossier teaser's gate is a different block.
    expect(screen.getAllByTestId("login-banner")).toHaveLength(1);
  });

  // The About card's two reads are started with the page's other reads, but never
  // inside the critical Promise.all: the details (cached, retried) are caught into
  // null, so a failure drops the description, not the page, and the deltas reader
  // returns all-nulls on its own.
  it("starts the About card's two reads beside the page's others, never inside the critical Promise.all", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "../page.tsx"), "utf8");
    const critical = /await Promise\.all\(\[([\s\S]*?)\]\)/.exec(source)?.[1] ?? "";
    // The stock itself is the critical read: the pattern found the right block.
    expect(critical).toContain("loadStockOrFail");
    expect(critical).not.toContain("getStockDetails");
    expect(critical).not.toContain("getShortInterestDeltas");
    expect(source).toMatch(/getStockDetails\(stockCode\)\.catch\(/);
    expect(source).toContain("getShortInterestDeltas(stockCode)");
  });
});
