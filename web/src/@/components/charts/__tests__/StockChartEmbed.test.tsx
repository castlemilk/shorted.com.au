import { fireEvent, render, screen, within } from "@testing-library/react";
import { useSession } from "next-auth/react";
import { StockChartEmbed } from "../StockChartEmbed";
import type { StockChartData } from "../use-stock-chart-data";
import type { ChartPoint } from "../types";

// The data hook is the embed's only source of numbers, the element-size hook its
// only measurement, and the chart its only drawing: all three are stood in for,
// so these tests are about what the embed hands the chart.
const mockChartData = jest.fn<StockChartData, [string, string]>();
jest.mock("../use-stock-chart-data", () => ({
  useStockChartData: (code: string, period: string) => mockChartData(code, period),
}));

// The warm-up history is a query, and the embed's tests have no QueryClient: it is
// stood in for. It records the period and the indicators the embed asked for, and
// reports the readiness the embed reads: which selected indicators still wait for
// their history (`waiting`), and whether a price or short load is pending.
let warmupPending = false;
let warmupWaiting: string[] = [];
const mockIndicatorHistory = jest.fn(
  (_code: string, _period: string, _ids: readonly string[]) => ({
    price: undefined,
    short: undefined,
    pricePending: warmupPending,
    shortPending: false,
    waiting: warmupWaiting,
  }),
);
jest.mock("../use-indicator-history", () => ({
  useIndicatorHistory: (code: string, period: string, ids: readonly string[]) =>
    mockIndicatorHistory(code, period, ids),
}));

// jsdom has no layout: the chart's box is given. The embed draws nothing until it
// has been measured, and picks its readout from the height.
let mockChartBox = { width: 420, height: 400 };
jest.mock("@/hooks/use-element-size", () => ({
  useElementSize: () => [jest.fn(), mockChartBox],
}));

jest.mock("../StockChart", () => ({
  StockChart: (props: {
    height?: number;
    series: unknown[];
    readout?: string;
    readoutReserveSeries?: number;
    indicatorLegend?: boolean;
    indicators?: { id: string }[];
    oscillators?: { id: string; caption?: string; values: (number | null)[] }[];
  }) => (
    <div
      data-testid="stock-chart"
      data-series={props.series.length}
      data-readout={props.readout}
      // Absent when the embed holds no readout rows for series still to come.
      data-reserve={props.readoutReserveSeries === undefined ? "" : String(props.readoutReserveSeries)}
      data-legend={String(!!props.indicatorLegend)}
      // The ids of the overlays and of the panel the chart was given, in order.
      data-indicators={(props.indicators ?? []).map((i) => i.id).join(",")}
      data-oscillators={(props.oscillators ?? []).map((o) => o.id).join(",")}
      // Per panel: how many values it carries, and its caption. A waiting panel is drawn
      // empty, so it carries none.
      data-oscillator-values={(props.oscillators ?? [])
        .map((o) => o.values.filter((v) => v !== null).length)
        .join(",")}
      data-oscillator-captions={(props.oscillators ?? []).map((o) => o.caption ?? "").join(",")}
    />
  ),
}));

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 0, 1);
const line = (n: number, from: number, step: number): ChartPoint[] =>
  Array.from({ length: n }, (_, i) => ({ t: T0 + i * DAY, v: from + i * step }));

function data(over: Partial<StockChartData> = {}): StockChartData {
  return {
    short: line(40, 2, 0.05),
    price: line(40, 10, 0.2),
    volume: line(40, 1000, 0),
    correlation: 0.55,
    anyLoading: false,
    isError: false,
    ...over,
  };
}

beforeEach(() => {
  mockChartBox = { width: 420, height: 400 };
  mockChartData.mockReset();
  mockChartData.mockImplementation(() => data());
  mockIndicatorHistory.mockClear();
  warmupPending = false;
  warmupWaiting = [];
});

/** Opens the Indicators menu, unless it is open already, and returns it. */
function openIndicators() {
  const trigger = screen.getByRole("button", { name: /^Indicators/ });
  if (trigger.getAttribute("aria-expanded") !== "true") fireEvent.click(trigger);
  return screen.getByRole("group", { name: "Chart indicators" });
}

// A narrow frame (an iframe on a phone) reads through a strip with a row for each
// series, 18px apiece. The price and the short series load separately, so the
// second to land would add a row and move the plot under the reader.
describe("StockChartEmbed: the readout's rows", () => {
  const reserve = () => screen.getByTestId("stock-chart").getAttribute("data-reserve");

  it("holds both series' rows in the Combined view, so the strip is as tall before the second series lands", () => {
    render(<StockChartEmbed stockCode="BHP" defaultView="combined" />);
    expect(reserve()).toBe("2");
  });

  it("holds them while only one of the two has arrived, which is when it matters", () => {
    mockChartData.mockImplementation(() => data({ short: [], anyLoading: true }));
    const { rerender } = render(<StockChartEmbed stockCode="BHP" defaultView="combined" />);
    // The price alone: one series, two rows held.
    expect(screen.getByTestId("stock-chart")).toHaveAttribute("data-series", "1");
    expect(reserve()).toBe("2");

    mockChartData.mockImplementation(() => data());
    rerender(<StockChartEmbed stockCode="BHP" defaultView="combined" />);
    expect(screen.getByTestId("stock-chart")).toHaveAttribute("data-series", "2");
    expect(reserve()).toBe("2");
  });

  it("holds them the other way round too: the short series first, the price after", () => {
    mockChartData.mockImplementation(() => data({ price: [], volume: [], anyLoading: true }));
    render(<StockChartEmbed stockCode="BHP" defaultView="combined" />);
    expect(screen.getByTestId("stock-chart")).toHaveAttribute("data-series", "1");
    expect(reserve()).toBe("2");
  });

  it("holds them whichever readout the frame's height picks", () => {
    mockChartBox = { width: 420, height: 400 };
    const tall = render(<StockChartEmbed stockCode="BHP" defaultView="combined" />);
    expect(screen.getByTestId("stock-chart")).toHaveAttribute("data-readout", "strip");
    expect(reserve()).toBe("2");
    tall.unmount();

    mockChartBox = { width: 420, height: 200 };
    render(<StockChartEmbed stockCode="BHP" defaultView="combined" />);
    expect(screen.getByTestId("stock-chart")).toHaveAttribute("data-readout", "tooltip");
    expect(reserve()).toBe("2");
  });

  it.each([["short"], ["price"]] as const)("holds none in the %s view: it has the one row", (view) => {
    render(<StockChartEmbed stockCode="BHP" defaultView={view} />);
    expect(reserve()).toBe("");
  });

  it("holds none by default: the default view is the short interest one", () => {
    render(<StockChartEmbed stockCode="BHP" />);
    expect(reserve()).toBe("");
  });
});

// A phone held upright gives the chart a tall, narrow plot, and with rotation
// locked the reader cannot turn it (reported 2026-10-19, WBT opened from
// Discord). The landscape mode draws the chart sideways instead.
describe("StockChartEmbed: landscape mode", () => {
  const box = (container: HTMLElement) => container.firstElementChild as HTMLElement;

  it("is offered only where the chart is the page", () => {
    render(<StockChartEmbed stockCode="BHP" />);
    expect(screen.queryByRole("button", { name: /landscape/i })).not.toBeInTheDocument();
  });

  it("turns the chart's box sideways on a portrait screen, and back", () => {
    const { container } = render(<StockChartEmbed stockCode="WBT" allowLandscape />);
    const toggle = screen.getByRole("button", { name: "Rotate chart to landscape" });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(box(container)).not.toHaveAttribute("data-landscape");

    fireEvent.click(toggle);
    expect(box(container)).toHaveAttribute("data-landscape", "true");
    // Rotated only while the viewport is portrait; a landscape viewport (the
    // phone turned with rotation unlocked) gets the same box, unrotated.
    expect(box(container).className).toContain("portrait:rotate-90");
    expect(box(container).className).toContain("fixed");
    // The way back stays on screen whatever the viewport does.
    const back = screen.getByRole("button", { name: "Back to portrait" });
    expect(back).toHaveAttribute("aria-pressed", "true");
    expect(back.className).not.toMatch(/(^|\s)hidden(\s|$)/);

    fireEvent.click(back);
    expect(box(container)).not.toHaveAttribute("data-landscape");
  });

  describe("opened sideways (a link from Discord, whose browser keeps to portrait)", () => {
    const realMatchMedia = window.matchMedia;
    const screenIs = (portraitPhone: boolean) => {
      window.matchMedia = ((query: string) => ({
        matches: portraitPhone && query.includes("orientation: portrait"),
        media: query,
      })) as unknown as typeof window.matchMedia;
    };
    afterEach(() => {
      window.matchMedia = realMatchMedia;
    });

    it("starts turned on a phone held upright", () => {
      screenIs(true);
      const { container } = render(<StockChartEmbed stockCode="WBT" allowLandscape startLandscape />);
      expect(box(container)).toHaveAttribute("data-landscape", "true");
      expect(screen.getByRole("button", { name: "Back to portrait" })).toBeInTheDocument();
    });

    it("leaves any other screen as it is", () => {
      screenIs(false);
      const { container } = render(<StockChartEmbed stockCode="WBT" allowLandscape startLandscape />);
      expect(box(container)).not.toHaveAttribute("data-landscape");
    });

    it("needs landscape mode to be offered at all", () => {
      screenIs(true);
      const { container } = render(<StockChartEmbed stockCode="WBT" startLandscape />);
      expect(box(container)).not.toHaveAttribute("data-landscape");
    });

    it("does not report its own start to the parent", () => {
      screenIs(true);
      const onLandscapeChange = jest.fn();
      render(
        <StockChartEmbed stockCode="WBT" allowLandscape startLandscape onLandscapeChange={onLandscapeChange} />,
      );
      expect(screen.getByRole("button", { name: "Back to portrait" })).toBeInTheDocument();
      expect(onLandscapeChange).not.toHaveBeenCalled();
    });
  });

  it("leaves with Escape", () => {
    const { container } = render(<StockChartEmbed stockCode="WBT" allowLandscape />);
    fireEvent.click(screen.getByRole("button", { name: "Rotate chart to landscape" }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(box(container)).not.toHaveAttribute("data-landscape");
  });
});

describe("StockChartEmbed: open full screen (framed)", () => {
  it("links to the share page at the period on screen", () => {
    render(<StockChartEmbed stockCode="WBT" defaultView="combined" defaultPeriod="1m" expandable />);
    const link = screen.getByRole("link", { name: "Open WBT chart full screen" });
    expect(link).toHaveAttribute(
      "href",
      "https://shorted.com.au/chart/WBT?view=combined&period=1m",
    );
    expect(link).toHaveAttribute("target", "_blank");

    fireEvent.click(screen.getByRole("button", { name: "6m" }));
    expect(link).toHaveAttribute(
      "href",
      "https://shorted.com.au/chart/WBT?view=combined&period=6m",
    );
  });

  it("is absent unless asked for", () => {
    render(<StockChartEmbed stockCode="WBT" />);
    expect(screen.queryByRole("link", { name: /full screen/ })).not.toBeInTheDocument();
  });
});

// A publisher's embed keeps the view they chose; the Discord Activity hands the
// view to the reader.
describe("StockChartEmbed: selectableView", () => {
  it("offers no view control by default", () => {
    render(<StockChartEmbed stockCode="BHP" defaultView="short" />);
    expect(screen.queryByRole("group", { name: "View" })).not.toBeInTheDocument();
  });

  it("switches the chart between the views when the reader picks one", () => {
    render(<StockChartEmbed stockCode="BHP" defaultView="short" selectableView />);
    const views = screen.getByRole("group", { name: "View" });
    expect(views).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Short" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("stock-chart")).toHaveAttribute("data-series", "1");

    fireEvent.click(screen.getByRole("button", { name: "Combined" }));
    expect(screen.getByRole("button", { name: "Combined" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Short" })).toHaveAttribute("aria-pressed", "false");
    // Price and short interest together, the strip holding both rows.
    expect(screen.getByTestId("stock-chart")).toHaveAttribute("data-series", "2");
    expect(screen.getByTestId("stock-chart")).toHaveAttribute("data-reserve", "2");
  });
});

// The Discord Activity keeps the reader's landscape choice across a stock switch, so the
// parent is told about the reader's own changes (not the automatic start), and Escape
// reaches the window only after the page has had its say.
describe("StockChartEmbed: landscape reporting", () => {
  const box = (container: HTMLElement) => container.firstElementChild as HTMLElement;

  it("tells the parent when the reader turns landscape on and off", () => {
    const onLandscapeChange = jest.fn();
    render(<StockChartEmbed stockCode="WBT" allowLandscape onLandscapeChange={onLandscapeChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Rotate chart to landscape" }));
    expect(onLandscapeChange).toHaveBeenLastCalledWith(true);
    fireEvent.click(screen.getByRole("button", { name: "Back to portrait" }));
    expect(onLandscapeChange).toHaveBeenLastCalledWith(false);
    expect(onLandscapeChange).toHaveBeenCalledTimes(2);
  });

  it("tells the parent when Escape leaves landscape", () => {
    const onLandscapeChange = jest.fn();
    render(<StockChartEmbed stockCode="WBT" allowLandscape onLandscapeChange={onLandscapeChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Rotate chart to landscape" }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onLandscapeChange).toHaveBeenLastCalledWith(false);
    expect(onLandscapeChange).toHaveBeenCalledTimes(2);
  });

  it("hears nothing from Escape while it is portrait", () => {
    const onLandscapeChange = jest.fn();
    render(<StockChartEmbed stockCode="WBT" allowLandscape onLandscapeChange={onLandscapeChange} />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onLandscapeChange).not.toHaveBeenCalled();
  });

  it("keeps landscape when the Escape was already handled before it arrives", () => {
    const { container } = render(<StockChartEmbed stockCode="WBT" allowLandscape />);
    fireEvent.click(screen.getByRole("button", { name: "Rotate chart to landscape" }));
    const handled = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    handled.preventDefault();
    document.dispatchEvent(handled);
    expect(box(container)).toHaveAttribute("data-landscape", "true");
  });

  it("keeps landscape when a dialog takes the Escape on the capture phase, as Radix does", () => {
    const { container } = render(<StockChartEmbed stockCode="WBT" allowLandscape />);
    fireEvent.click(screen.getByRole("button", { name: "Rotate chart to landscape" }));
    const takeEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") e.preventDefault();
    };
    document.addEventListener("keydown", takeEscape, true);
    try {
      fireEvent.keyDown(document, { key: "Escape" });
    } finally {
      document.removeEventListener("keydown", takeEscape, true);
    }
    expect(box(container)).toHaveAttribute("data-landscape", "true");
  });
});

// The Indicators menu, for a host that offers it: the share page (a session unlocks the
// advanced indicators) and the Discord Activity (they stay locked, and sign-in is the
// host's). A publisher's embed, which offers none, has no menu at all.
describe("StockChartEmbed: indicators", () => {
  const session = jest.mocked(useSession);
  const signedIn = session.getMockImplementation();
  afterEach(() => {
    session.mockImplementation(signedIn);
    warmupPending = false;
    mockChartBox = { width: 420, height: 400 };
  });

  const signedOut = () =>
    session.mockImplementation(
      () => ({ data: null, status: "unauthenticated", update: jest.fn() }) as never,
    );

  it("offers nothing without the prop: no menu, no legend, and no history asked for", () => {
    render(<StockChartEmbed stockCode="BHP" defaultView="combined" />);
    expect(screen.queryByRole("button", { name: /^Indicators/ })).not.toBeInTheDocument();
    expect(screen.getByTestId("stock-chart")).toHaveAttribute("data-legend", "false");
    expect(mockIndicatorHistory).toHaveBeenLastCalledWith("BHP", "1y", []);
  });

  it("draws its trigger in the header row, after the period control", () => {
    render(
      <StockChartEmbed stockCode="BHP" defaultView="combined" indicators={{ unlock: "never" }} />,
    );
    const header = document.querySelector<HTMLElement>("[data-embed-header]")!;
    const period = within(header).getByRole("group", { name: "Period" });
    const trigger = within(header).getByRole("button", { name: /^Indicators/ });
    expect(period.compareDocumentPosition(trigger) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("starts from the picks it is given, and says how many are on", () => {
    render(
      <StockChartEmbed
        stockCode="BHP"
        defaultView="combined"
        indicators={{ unlock: "never", initial: ["sma20"] }}
      />,
    );
    expect(screen.getByTestId("stock-chart")).toHaveAttribute("data-indicators", "sma20");
    expect(screen.getByRole("button", { name: /^Indicators/ })).toHaveAccessibleName(
      /^Indicators\s*,\s*1 on$/,
    );
  });

  it("draws a base indicator for every visitor, with the in-plot legend", () => {
    render(
      <StockChartEmbed stockCode="BHP" defaultView="combined" indicators={{ unlock: "never" }} />,
    );
    fireEvent.click(within(openIndicators()).getByRole("button", { name: "SMA 20" }));
    expect(screen.getByTestId("stock-chart")).toHaveAttribute("data-indicators", "sma20");
    expect(screen.getByTestId("stock-chart")).toHaveAttribute("data-legend", "true");
  });

  it("keeps the advanced indicators locked where the host cannot hold a session, and hands sign-in to the host", () => {
    // The session mock is signed in: "never" ignores it, as the Activity cannot hold one.
    const onSignIn = jest.fn();
    render(
      <StockChartEmbed
        stockCode="BHP"
        defaultView="combined"
        indicators={{ unlock: "never", onSignIn }}
      />,
    );
    const panel = openIndicators();
    expect(within(panel).getByText("SMA 200")).toBeInTheDocument();
    expect(within(panel).queryByRole("button", { name: "SMA 200" })).not.toBeInTheDocument();
    expect(panel.querySelectorAll("a")).toHaveLength(0);
    fireEvent.click(within(panel).getByRole("button", { name: "Sign in on Shorted" }));
    expect(onSignIn).toHaveBeenCalledWith({ stockCode: "BHP", view: "combined", period: "1y" });
  });

  it("sends a signed-out visitor to sign in, and back to the chart's share page", () => {
    signedOut();
    render(
      <StockChartEmbed stockCode="BHP" defaultView="combined" indicators={{ unlock: "session" }} />,
    );
    expect(
      within(openIndicators()).getByRole("link", { name: "Sign in to unlock" }),
    ).toHaveAttribute("href", "/signin?callbackUrl=%2Fchart%2FBHP%3Fview%3Dcombined");
  });

  it("returns the reader to the share page turned sideways, when the chart is", () => {
    signedOut();
    render(
      <StockChartEmbed
        stockCode="BHP"
        defaultView="combined"
        allowLandscape
        indicators={{ unlock: "session" }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Rotate chart to landscape" }));
    expect(
      within(openIndicators()).getByRole("link", { name: "Sign in to unlock" }),
    ).toHaveAttribute(
      "href",
      "/signin?callbackUrl=%2Fchart%2FBHP%3Fview%3Dcombined%26landscape%3D1",
    );
  });

  it("draws a panel indicator only where the chart is tall enough for one", () => {
    mockChartBox = { width: 420, height: 300 };
    // A new element each render: React skips a re-render of the same element object.
    const host = () => (
      <StockChartEmbed stockCode="BHP" defaultView="combined" indicators={{ unlock: "session" }} />
    );
    const { rerender } = render(host());
    const rsi = within(openIndicators()).getByRole("button", { name: /^RSI 14/ });
    expect(rsi).toHaveAttribute("aria-disabled", "true");
    expect(rsi).toHaveTextContent("Needs a taller chart");
    fireEvent.click(rsi);
    expect(screen.getByTestId("stock-chart")).toHaveAttribute("data-oscillators", "");

    mockChartBox = { width: 420, height: 400 };
    rerender(host());
    fireEvent.click(
      within(screen.getByRole("group", { name: "Chart indicators" })).getByRole("button", {
        name: /^RSI 14/,
      }),
    );
    expect(screen.getByTestId("stock-chart")).toHaveAttribute("data-oscillators", "rsi14");
  });

  it("closes its menu on Escape and stays in landscape; a second Escape leaves landscape", () => {
    const { container } = render(
      <StockChartEmbed
        stockCode="BHP"
        defaultView="combined"
        allowLandscape
        indicators={{ unlock: "session" }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Rotate chart to landscape" }));
    const panel = openIndicators();
    // The menu takes an Escape pressed from inside it (where focus is, on its first toggle).
    fireEvent.keyDown(within(panel).getAllByRole("button")[0]!, { key: "Escape" });
    expect(screen.queryByRole("group", { name: "Chart indicators" })).not.toBeInTheDocument();
    expect(container.firstElementChild).toHaveAttribute("data-landscape", "true");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(container.firstElementChild).not.toHaveAttribute("data-landscape");
  });

  it("tells the host the picks as the reader makes them, in registry order", () => {
    const onChange = jest.fn();
    render(
      <StockChartEmbed stockCode="BHP" defaultView="combined" indicators={{ unlock: "never", onChange }} />,
    );
    fireEvent.click(within(openIndicators()).getByRole("button", { name: "SMA 50" }));
    expect(onChange).toHaveBeenLastCalledWith(["sma50"]);
    fireEvent.click(within(openIndicators()).getByRole("button", { name: "SMA 20" }));
    expect(onChange).toHaveBeenLastCalledWith(["sma20", "sma50"]);
  });

  it("asks for the warm-up history of what it draws, and holds an indicator back until that lands", () => {
    // SMA 20 is the indicator that waits for the earlier history: the hook reports it.
    warmupPending = true;
    warmupWaiting = ["sma20"];
    render(
      <StockChartEmbed
        stockCode="BHP"
        defaultView="price"
        defaultPeriod="1m"
        indicators={{ unlock: "never", initial: ["sma20"] }}
      />,
    );
    expect(mockIndicatorHistory).toHaveBeenLastCalledWith("BHP", "1m", ["sma20"]);
    expect(screen.getByTestId("stock-chart")).toHaveAttribute("data-indicators", "");
  });
});

// The Discord Activity holds the landscape choice itself, outside the chart. Given a
// `landscape`, the chart renders from it, never reads the screen for `startLandscape`, and
// only reports the toggle and Escape: the host answers by changing `landscape`.
describe("StockChartEmbed: a landscape choice the host holds", () => {
  const box = (container: HTMLElement) => container.firstElementChild as HTMLElement;
  const realMatchMedia = window.matchMedia;
  afterEach(() => {
    window.matchMedia = realMatchMedia;
  });

  it("renders from the host, and does not read the screen for startLandscape", () => {
    const matchMedia = jest.fn((query: string) => ({
      matches: query.includes("orientation: portrait"),
      media: query,
    }));
    window.matchMedia = matchMedia as unknown as typeof window.matchMedia;
    const { container, rerender } = render(
      <StockChartEmbed stockCode="WBT" allowLandscape startLandscape landscape={false} />,
    );
    expect(box(container)).not.toHaveAttribute("data-landscape");
    expect(matchMedia).not.toHaveBeenCalled();

    rerender(<StockChartEmbed stockCode="WBT" allowLandscape startLandscape landscape />);
    expect(box(container)).toHaveAttribute("data-landscape", "true");
  });

  it("only reports the toggle and Escape: the chart shows what the host holds", () => {
    const onLandscapeChange = jest.fn();
    const { container } = render(
      <StockChartEmbed stockCode="WBT" allowLandscape landscape onLandscapeChange={onLandscapeChange} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Back to portrait" }));
    expect(onLandscapeChange).toHaveBeenLastCalledWith(false);
    // The host has not answered, so the chart stays as it is held.
    expect(box(container)).toHaveAttribute("data-landscape", "true");

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onLandscapeChange).toHaveBeenCalledTimes(2);
    expect(box(container)).toHaveAttribute("data-landscape", "true");
  });
});

describe("StockChartEmbed: chart overlay", () => {
  it("draws it inside the chart's box, which is the box it positions against", () => {
    render(<StockChartEmbed stockCode="BHP" chartOverlay={<div data-testid="overlay" />} />);
    expect(screen.getByTestId("overlay").parentElement).toHaveClass("relative");
  });
});

// The stock page's panel does the same: the menu follows the view the chart is drawn as,
// an indicator that waits for its history holds its place (a panel drawn empty), and
// what is counted is what is on the chart.
describe("StockChartEmbed: what is on screen", () => {
  const stockChart = () => screen.getByTestId("stock-chart");

  it("draws a waiting panel empty, with its caption, so the plot keeps its height", () => {
    warmupWaiting = ["rsi14"];
    render(
      <StockChartEmbed
        stockCode="BHP"
        defaultView="combined"
        indicators={{ unlock: "session", initial: ["rsi14"] }}
      />,
    );
    expect(stockChart()).toHaveAttribute("data-oscillators", "rsi14");
    expect(stockChart()).toHaveAttribute("data-oscillator-values", "0");
    expect(stockChart()).toHaveAttribute("data-oscillator-captions", "RSI 14");
  });

  it("draws no waiting panel on a chart too short for one, and counts none", () => {
    warmupWaiting = ["rsi14"];
    mockChartBox = { width: 420, height: 300 };
    render(
      <StockChartEmbed
        stockCode="BHP"
        defaultView="combined"
        indicators={{ unlock: "session", initial: ["rsi14"] }}
      />,
    );
    expect(stockChart()).toHaveAttribute("data-oscillators", "");
    expect(screen.getByRole("button", { name: /^Indicators/ })).toHaveAccessibleName(
      "Indicators",
    );
  });

  it("holds back an indicator that waits for its history", () => {
    warmupPending = true;
    warmupWaiting = ["sma20"];
    render(
      <StockChartEmbed
        stockCode="BHP"
        defaultView="combined"
        indicators={{ unlock: "never", initial: ["sma20"] }}
      />,
    );
    expect(stockChart()).toHaveAttribute("data-indicators", "");
  });

  it("draws an indicator whose history is in while another one still loads", () => {
    warmupPending = true;
    warmupWaiting = [];
    render(
      <StockChartEmbed
        stockCode="BHP"
        defaultView="combined"
        indicators={{ unlock: "never", initial: ["sma20"] }}
      />,
    );
    expect(stockChart()).toHaveAttribute("data-indicators", "sma20");
  });

  it("offers and fetches only for the series a Combined chart draws when it has one", () => {
    mockChartData.mockImplementation(() => data({ price: [] }));
    render(
      <StockChartEmbed
        stockCode="BHP"
        defaultView="combined"
        indicators={{ unlock: "never", initial: ["sma20"] }}
      />,
    );
    expect(stockChart()).toHaveAttribute("data-series", "1");
    expect(stockChart()).toHaveAttribute("data-indicators", "");
    const panel = openIndicators();
    expect(within(panel).queryByText("SMA 20")).not.toBeInTheDocument();
    expect(within(panel).getByText("Short 30-day avg")).toBeInTheDocument();
    // The one series drawn is short interest, so no price indicator was asked for.
    expect(mockIndicatorHistory).toHaveBeenLastCalledWith("BHP", "1y", []);
  });

  it("counts the one on the chart when another selected one has nothing to draw yet", () => {
    mockChartData.mockImplementation(() => data({ short: line(5, 2, 0.05) }));
    render(
      <StockChartEmbed
        stockCode="BHP"
        defaultView="combined"
        indicators={{ unlock: "session", initial: ["sma20", "short-avg-30d"] }}
      />,
    );
    expect(stockChart()).toHaveAttribute("data-indicators", "sma20");
    expect(screen.getByRole("button", { name: /^Indicators/ })).toHaveAccessibleName(
      /^Indicators\s*,\s*1 on$/,
    );
    expect(within(openIndicators()).getByText("Not enough history")).toBeInTheDocument();
  });

  it("says which selected indicators have nothing to draw for want of history, and counts only what is drawn", () => {
    // Five days of short interest: no 30-day average has a value yet.
    mockChartData.mockImplementation(() => data({ short: line(5, 2, 0.05) }));
    render(
      <StockChartEmbed
        stockCode="BHP"
        defaultView="combined"
        indicators={{ unlock: "session", initial: ["short-avg-30d"] }}
      />,
    );
    expect(stockChart()).toHaveAttribute("data-indicators", "");
    expect(screen.getByRole("button", { name: /^Indicators/ })).toHaveAccessibleName(
      "Indicators",
    );
    expect(within(openIndicators()).getByText("Not enough history")).toBeInTheDocument();
  });
});

// A Combined chart with one of its series says what is missing. The note is UI copy, so
// it keeps to the house punctuation (DESIGN.md: no em dashes).
describe("StockChartEmbed: the note for a missing series", () => {
  const cases: [Partial<StockChartData>, string][] = [
    [{ short: [] }, "No short position data for this period. Showing price only."],
    [{ price: [], volume: [] }, "No price data for this period. Showing short interest only."],
  ];
  it.each(cases)("says what is missing, in plain punctuation: %#", (over, note) => {
    mockChartData.mockImplementation(() => data(over));
    render(<StockChartEmbed stockCode="BHP" defaultView="combined" />);
    expect(screen.getByText(note)).toBeInTheDocument();
    expect(note).not.toMatch(/[–—]/);
  });
});

describe("StockChartEmbed: header actions", () => {
  it("draws them in the header row, after the period control and before the landscape toggle", () => {
    render(
      <StockChartEmbed
        stockCode="BHP"
        allowLandscape
        headerActions={<button type="button">Find a stock</button>}
      />,
    );
    const header = document.querySelector<HTMLElement>("[data-embed-header]")!;
    const period = within(header).getByRole("group", { name: "Period" });
    const action = within(header).getByRole("button", { name: "Find a stock" });
    const toggle = within(header).getByRole("button", { name: "Rotate chart to landscape" });
    expect(period.compareDocumentPosition(action) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(action.compareDocumentPosition(toggle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
