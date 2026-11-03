import type { ReactNode } from "react";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import {
  activityLaunchState,
  activitySignInUrl,
} from "~/@/lib/discord/activity";
import { DiscordActivity } from "../discord-activity";

// The chart is stood in for. These tests are about the Activity's own shell: the
// header row's buttons, the search dialog, the link fallback, and what it hands the chart.
// The stand-in has two controls that play the chart's part in the indicator menu: one
// picks an indicator (the chart reports it), one asks to sign in (the chart hands it up).
jest.mock("~/@/components/charts/StockChartEmbed", () => ({
  EMBED_CONTROL_BUTTON: "",
  StockChartEmbed: (props: {
    stockCode: string;
    anchor?: { day: string } | null;
    landscape?: boolean;
    headerActions?: ReactNode;
    chartOverlay?: ReactNode;
    indicators?: {
      initial?: readonly string[];
      onChange?: (ids: readonly string[]) => void;
      onSignIn?: (chart: {
        stockCode: string;
        view: string;
        period: string;
      }) => void;
    };
  }) => (
    <div
      data-testid="embed"
      data-code={props.stockCode}
      data-anchor={props.anchor?.day ?? ""}
      data-landscape={String(!!props.landscape)}
      data-initial={(props.indicators?.initial ?? []).join(",")}
    >
      <div data-embed-header>{props.headerActions}</div>
      {props.chartOverlay}
      <button
        type="button"
        onClick={() => props.indicators?.onChange?.(["sma20"])}
      >
        Stub pick SMA 20
      </button>
      <button
        type="button"
        onClick={() =>
          props.indicators?.onSignIn?.({
            stockCode: "CBA",
            view: "combined",
            period: "max",
          })
        }
      >
        Stub sign-in
      </button>
    </div>
  ),
}));

// Generated protobuf code, stood in for. The search answers nothing here: a typed code is
// picked straight away, without waiting for hits.
jest.mock("~/gen/shorts/v1alpha1/search_pb", () => ({ SearchService: {} }));
jest.mock("@connectrpc/connect", () => ({
  createClient: () => ({
    searchStocks: jest.fn(() => Promise.resolve({ stocks: [] })),
  }),
}));
jest.mock("@connectrpc/connect-web", () => ({
  createConnectTransport: () => ({}),
}));

const QUERY = "code=CBA&view=combined&period=max";

/** Renders the Activity at `query` on its own URL, as Discord's proxy serves it. */
function renderActivity(query: string, platform: "mobile" | "desktop" | null) {
  window.history.replaceState(null, "", `/embed/discord?${query}`);
  return render(
    <DiscordActivity
      launch={activityLaunchState(new URLSearchParams(query))}
      platform={platform}
    />,
  );
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe("DiscordActivity: the chart is the page", () => {
  it("renders no links, and its header row holds the search and open buttons", () => {
    renderActivity(QUERY, null);
    expect(document.querySelectorAll("a")).toHaveLength(0);
    const header = document.querySelector<HTMLElement>("[data-embed-header]")!;
    expect(
      within(header).getByRole("button", { name: "Search stocks" }),
    ).toBeInTheDocument();
    expect(
      within(header).getByRole("button", { name: "Open CBA on Shorted" }),
    ).toBeInTheDocument();
  });

  it("opens the stock in a plain tab outside Discord", () => {
    const open = jest.spyOn(window, "open").mockImplementation(() => null);
    renderActivity(QUERY, null);
    fireEvent.click(
      screen.getByRole("button", { name: "Open CBA on Shorted" }),
    );
    expect(open).toHaveBeenCalledWith(
      "https://shorted.com.au/shorts/CBA",
      "_blank",
      "noopener,noreferrer",
    );
  });

  it("never opens a window inside Discord, and shows the link to copy when it cannot leave", async () => {
    const open = jest.spyOn(window, "open").mockImplementation(() => null);
    renderActivity(
      "frame_id=f&instance_id=i&platform=mobile&code=CBA",
      "mobile",
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Open CBA on Shorted" }),
    );
    // No SDK on localhost, so the wait for one ends at once and the address is offered as text.
    // The status region is always mounted: wait for its text, not for the element.
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        "Copy it into your browser",
      ),
    );
    expect(
      screen.getByText("https://shorted.com.au/shorts/CBA"),
    ).toBeInTheDocument();
    expect(open).not.toHaveBeenCalled();
  });
});

describe("DiscordActivity: landscape", () => {
  // The screen is read through matchMedia, which jsdom does not provide. Stood in for:
  // a portrait phone, or a landscape screen.
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

  it.each([
    ["mobile", "true"],
    ["desktop", "false"],
    [null, "false"],
  ] as const)(
    "starts turned sideways only for a phone's launch on a portrait phone (platform: %s)",
    (platform, expected) => {
      screenIs(true);
      renderActivity(
        "frame_id=f&instance_id=i&platform=mobile&code=CBA",
        platform,
      );
      expect(screen.getByTestId("embed")).toHaveAttribute(
        "data-landscape",
        expected,
      );
    },
  );

  it("starts upright on a phone's launch when the screen is already landscape", () => {
    screenIs(false);
    renderActivity(
      "frame_id=f&instance_id=i&platform=mobile&code=CBA",
      "mobile",
    );
    expect(screen.getByTestId("embed")).toHaveAttribute(
      "data-landscape",
      "false",
    );
  });

  it("hands the chart the Activity's own choice, so a stock switch keeps it", async () => {
    screenIs(true);
    renderActivity(
      "frame_id=f&instance_id=i&platform=mobile&code=CBA",
      "mobile",
    );
    expect(screen.getByTestId("embed")).toHaveAttribute(
      "data-landscape",
      "true",
    );
    fireEvent.click(screen.getByRole("button", { name: /Search stocks/ }));
    fireEvent.change(
      screen.getByRole("searchbox", { name: "Search ASX stocks" }),
      {
        target: { value: "bhp" },
      },
    );
    fireEvent.submit(
      screen
        .getByRole("searchbox", { name: "Search ASX stocks" })
        .closest("form")!,
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(screen.getByTestId("embed")).toHaveAttribute("data-code", "BHP");
    expect(screen.getByTestId("embed")).toHaveAttribute(
      "data-landscape",
      "true",
    );
  });
});

describe("DiscordActivity: search button", () => {
  it("says it opens a dialog, and whether it is open", async () => {
    renderActivity(QUERY, null);
    const search = screen.getByRole("button", { name: "Search stocks" });
    expect(search).toHaveAttribute("aria-haspopup", "dialog");
    expect(search).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(search);
    expect(search).toHaveAttribute("aria-expanded", "true");
    fireEvent.keyDown(
      screen.getByRole("searchbox", { name: "Search ASX stocks" }),
      {
        key: "Escape",
      },
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(search).toHaveAttribute("aria-expanded", "false");
  });
});

// The chart's share page, turned sideways, as the Activity's sign-in returns to it.
const SIGN_IN_URL =
  "https://shorted.com.au/signin?callbackUrl=%2Fchart%2FCBA%3Fview%3Dcombined%26period%3Dmax%26landscape%3D1";

describe("DiscordActivity: advanced indicators", () => {
  it("opens the sign-in outside Discord, back to the chart's share page turned sideways", () => {
    const open = jest.spyOn(window, "open").mockImplementation(() => null);
    renderActivity(QUERY, null);
    fireEvent.click(screen.getByRole("button", { name: "Stub sign-in" }));
    expect(
      activitySignInUrl({ code: "CBA", view: "combined", period: "max" }),
    ).toBe(SIGN_IN_URL);
    expect(open).toHaveBeenCalledWith(
      SIGN_IN_URL,
      "_blank",
      "noopener,noreferrer",
    );
  });

  it("never opens a window inside Discord, and shows the sign-in link to copy", async () => {
    const open = jest.spyOn(window, "open").mockImplementation(() => null);
    renderActivity(
      "frame_id=f&instance_id=i&platform=mobile&code=CBA",
      "mobile",
    );
    fireEvent.click(screen.getByRole("button", { name: "Stub sign-in" }));
    expect(await screen.findByText(SIGN_IN_URL)).toBeInTheDocument();
    expect(open).not.toHaveBeenCalled();
  });

  it("keeps the picks across a stock switch", async () => {
    renderActivity(QUERY, null);
    expect(screen.getByTestId("embed")).toHaveAttribute("data-initial", "");
    fireEvent.click(screen.getByRole("button", { name: "Stub pick SMA 20" }));
    expect(screen.getByTestId("embed")).toHaveAttribute(
      "data-initial",
      "sma20",
    );

    fireEvent.click(screen.getByRole("button", { name: "Search stocks" }));
    const input = screen.getByRole("searchbox", { name: "Search ASX stocks" });
    fireEvent.change(input, { target: { value: "bhp" } });
    fireEvent.submit(input.closest("form")!);
    expect(screen.getByTestId("embed")).toHaveAttribute("data-code", "BHP");
    expect(screen.getByTestId("embed")).toHaveAttribute(
      "data-initial",
      "sma20",
    );
  });
});

describe("DiscordActivity: search", () => {
  it("searches in an upright dialog outside the chart, and Escape closes it", async () => {
    renderActivity(QUERY, null);
    fireEvent.click(screen.getByRole("button", { name: "Search stocks" }));
    const dialog = screen.getByRole("dialog", { name: "Search ASX stocks" });
    // Portalled to the body, so nothing inside the (possibly turned) chart positions it.
    // The real chart's landscape box is checked in discord-activity.sdk.test.tsx.
    expect(dialog.parentElement).toBe(document.body);
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
  });

  it("moves the chart to the stock picked, and closes the dialog", async () => {
    renderActivity(QUERY, null);
    fireEvent.click(screen.getByRole("button", { name: "Search stocks" }));
    const input = screen.getByRole("searchbox", { name: "Search ASX stocks" });
    fireEvent.change(input, { target: { value: "bhp" } });
    fireEvent.submit(input.closest("form")!);
    expect(screen.getByTestId("embed")).toHaveAttribute("data-code", "BHP");
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
  });
});

describe("DiscordActivity: a chart kept as posted", () => {
  const PINNED = "code=CBA&view=combined&period=3m&asof=2026-11-04&shorts=2026-10-29";

  it("opens the chart as posted on its day", () => {
    renderActivity(PINNED, null);
    expect(screen.getByTestId("embed")).toHaveAttribute("data-anchor", "2026-11-04");
  });

  it("opens a live chart when the launch names none", () => {
    renderActivity(QUERY, null);
    expect(screen.getByTestId("embed")).toHaveAttribute("data-anchor", "");
  });

  it("drops the anchor once a different stock is picked, since it is the posted stock's", async () => {
    renderActivity(PINNED, null);
    fireEvent.click(screen.getByRole("button", { name: "Search stocks" }));
    const input = screen.getByRole("searchbox", { name: "Search ASX stocks" });
    fireEvent.change(input, { target: { value: "bhp" } });
    fireEvent.submit(input.closest("form")!);
    expect(screen.getByTestId("embed")).toHaveAttribute("data-code", "BHP");
    expect(screen.getByTestId("embed")).toHaveAttribute("data-anchor", "");
  });
});

