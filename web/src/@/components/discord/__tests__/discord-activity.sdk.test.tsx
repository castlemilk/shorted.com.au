/**
 * @jest-environment-options {"url": "https://123456789012345678.discordsays.com/embed/discord?frame_id=f&instance_id=i&platform=mobile&code=CBA&view=combined&period=max"}
 */

// The Activity inside Discord, where the SDK path runs. The page is served from a
// discordsays host (the client id is 18 digits; 15 to 22 are accepted), so the Activity
// believes it is in Discord. The SDK is a stand-in whose ready() each test settles, or
// leaves pending, and whose openExternalLink is recorded. The chart is the real one: only
// its data, its size and its drawing are stood in for. The stock-page tests in
// discord-activity.test.tsx run off Discord, where the SDK is never reached.

import {
  activityLaunchState,
  activitySignInUrl,
} from "~/@/lib/discord/activity";

// React and Testing Library load per test (see beforeEach), so their own automatic
// cleanup, which registers an afterEach, must not run at import; cleanup is ours.
process.env.RTL_SKIP_AUTO_CLEANUP = "true";

// The SDK, stood in for. ready() is a promise each test sets; openExternalLink records
// what the Activity asked Discord to open.
const mockReady = jest.fn<Promise<void>, []>();
const mockOpenExternalLink = jest.fn<Promise<void>, [{ url: string }]>();
jest.mock("@discord/embedded-app-sdk", () => {
  class DiscordSDK {
    platform = "MOBILE";
    commands = {
      openExternalLink: (args: { url: string }) => mockOpenExternalLink(args),
      setOrientationLockState: () => Promise.resolve(),
    };
    constructor(_clientId: string, _options: unknown) {}
    ready() {
      return mockReady();
    }
  }
  return {
    DiscordSDK,
    Common: { OrientationLockStateTypeObject: { UNLOCKED: 2 } },
    Platform: { MOBILE: "MOBILE", DESKTOP: "DESKTOP" },
  };
});

// The chart's data, size and drawing are stood in for; the chart's own controls, its
// landscape logic and its indicator menu are real.
jest.mock("~/@/components/charts/use-stock-chart-data", () => ({
  useStockChartData: () => ({
    short: [
      { t: 1, v: 1 },
      { t: 2, v: 2 },
    ],
    price: [
      { t: 1, v: 1 },
      { t: 2, v: 2 },
    ],
    volume: [],
    correlation: 0,
    anyLoading: false,
    isError: false,
  }),
}));
jest.mock("@/hooks/use-element-size", () => ({
  useElementSize: () => [jest.fn(), { width: 420, height: 400 }],
}));
jest.mock("~/@/components/charts/StockChart", () => ({
  StockChart: () => <div data-testid="stock-chart" />,
}));
// The warm-up history is a data query: not needed here, as no indicator is drawn with one.
jest.mock("~/@/components/charts/use-indicator-history", () => {
  // The same shape as the real hook: nothing waits, and the list is one stable array.
  const nothingWaits: string[] = [];
  return {
    useIndicatorHistory: () => ({
      price: undefined,
      short: undefined,
      pricePending: false,
      shortPending: false,
      waiting: nothingWaits,
    }),
  };
});

// Generated protobuf and the search transport, stood in for (the search answers nothing).
jest.mock("~/gen/shorts/v1alpha1/search_pb", () => ({ SearchService: {} }));
jest.mock("@connectrpc/connect", () => ({
  createClient: () => ({
    searchStocks: jest.fn(() => Promise.resolve({ stocks: [] })),
  }),
}));
jest.mock("@connectrpc/connect-web", () => ({
  createConnectTransport: () => ({}),
}));

type Rtl = typeof import("@testing-library/react");
type ActivityModule = typeof import("~/@/components/discord/discord-activity");

let rtl: Rtl;
let render: Rtl["render"];
let screen: Rtl["screen"];
let fireEvent: Rtl["fireEvent"];
let act: Rtl["act"];
let waitFor: Rtl["waitFor"];
let DiscordActivity: ActivityModule["DiscordActivity"];

const realMatchMedia = window.matchMedia;
let portrait = true;

const STOCK_URL = "https://shorted.com.au/shorts/CBA";
const SIGN_IN_URL = activitySignInUrl({
  code: "CBA",
  view: "combined",
  period: "max",
});
const DISCORD_QUERY =
  "frame_id=f&instance_id=i&platform=mobile&code=CBA&view=combined&period=max";

beforeEach(() => {
  // A fresh module graph for each test. The Activity keeps its SDK handshake at module
  // level, which must not carry over from one test to the next. React and Testing
  // Library load into the same graph, or the hooks would belong to a second React.
  jest.isolateModules(() => {
    rtl = require("@testing-library/react") as Rtl;
    DiscordActivity = (
      require("~/@/components/discord/discord-activity") as ActivityModule
    ).DiscordActivity;
  });
  ({ render, screen, fireEvent, act, waitFor } = rtl);

  // A phone held upright, unless a test says the keyboard has reshaped it.
  portrait = true;
  window.matchMedia = ((query: string) => ({
    matches: portrait && query.includes("orientation: portrait"),
    media: query,
  })) as unknown as typeof window.matchMedia;

  // The handshake posts once to /api/discord/activity. jsdom has no fetch.
  Object.defineProperty(window, "fetch", {
    configurable: true,
    writable: true,
    value: jest.fn(() => Promise.resolve(new Response(null, { status: 204 }))),
  });

  mockReady.mockReset().mockResolvedValue(undefined);
  mockOpenExternalLink.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  rtl.cleanup();
  jest.useRealTimers();
  jest.restoreAllMocks();
  window.matchMedia = realMatchMedia;
  delete (window as { fetch?: unknown }).fetch;
});

/** Renders the Activity on its own URL, as Discord's proxy serves it. */
function renderActivity() {
  window.history.replaceState(null, "", `/embed/discord?${DISCORD_QUERY}`);
  return render(
    <DiscordActivity
      launch={activityLaunchState(new URLSearchParams(DISCORD_QUERY))}
      platform="mobile"
    />,
  );
}

/** Lets the promises already waiting run: the handshake is a chain of them. */
async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 25; i++) await Promise.resolve();
  });
}

const openButton = () =>
  screen.getByRole("button", { name: "Open CBA on Shorted" });
const fallback = () =>
  document.querySelector<HTMLElement>("[data-link-fallback]");
const landscapeBox = () => document.querySelector("[data-landscape]");

/** Types a code into the open search and submits it, then waits for the dialog to close. */
async function submitSearch(code: string) {
  const input = screen.getByRole("searchbox", { name: "Search ASX stocks" });
  fireEvent.change(input, { target: { value: code } });
  fireEvent.submit(input.closest("form")!);
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
}

/** Opens the search, picks a code, and waits for the dialog to close. */
async function pickStock(code: string) {
  fireEvent.click(screen.getByRole("button", { name: "Search stocks" }));
  await submitSearch(code);
}

describe("Open on Shorted, through the SDK", () => {
  it("leaves once, for the stock's page, and opens no window", async () => {
    const open = jest.spyOn(window, "open").mockImplementation(() => null);
    renderActivity();
    fireEvent.click(openButton());
    await settle();
    expect(mockOpenExternalLink).toHaveBeenCalledTimes(1);
    expect(mockOpenExternalLink).toHaveBeenCalledWith({ url: STOCK_URL });
    expect(open).not.toHaveBeenCalled();
    expect(fallback()).toBeNull();
  });

  it("shows the address to copy inside the chart, and opens nothing, when the SDK never connects", async () => {
    jest.useFakeTimers();
    const open = jest.spyOn(window, "open").mockImplementation(() => null);
    mockReady.mockReturnValue(new Promise<void>(() => undefined));
    renderActivity();
    fireEvent.click(openButton());
    await settle();
    // While the SDK is connecting, the button says it is busy.
    expect(openButton()).toHaveAttribute("aria-busy", "true");
    expect(fallback()).toBeNull();

    // The wait ends in a promise callback: flush the promises after each step, or a
    // check made just before the flush would see the fallback too late to fail.
    act(() => {
      jest.advanceTimersByTime(2_999);
    });
    await settle();
    expect(fallback()).toBeNull();
    act(() => {
      jest.advanceTimersByTime(1);
    });
    await settle();

    expect(fallback()).toHaveTextContent(STOCK_URL);
    // The fallback sits in the chart's box, so a landscape chart turns it with it.
    expect(fallback()!.parentElement).toHaveClass("relative");
    // Above the indicator menu (z-30), so a reader can always read and copy it.
    expect(fallback()).toHaveClass("z-40");
    expect(openButton()).not.toHaveAttribute("aria-busy");
    expect(screen.getByRole("status")).toHaveTextContent(
      "Copy it into your browser",
    );
    expect(mockOpenExternalLink).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it("does not open the link when the SDK connects after the wait", async () => {
    jest.useFakeTimers();
    let connect: () => void = () => undefined;
    mockReady.mockReturnValue(
      new Promise<void>((resolve) => {
        connect = resolve;
      }),
    );
    renderActivity();
    fireEvent.click(openButton());
    act(() => {
      jest.advanceTimersByTime(3_000);
    });
    await settle();
    expect(fallback()).toHaveTextContent(STOCK_URL);

    connect();
    await settle();
    expect(mockOpenExternalLink).not.toHaveBeenCalled();
    expect(fallback()).toHaveTextContent(STOCK_URL);
  });

  it("offers the address to copy when Discord refuses to open it", async () => {
    const error = jest
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    mockOpenExternalLink.mockRejectedValue(new Error("refused"));
    renderActivity();
    fireEvent.click(openButton());
    await settle();
    expect(mockOpenExternalLink).toHaveBeenCalledTimes(1);
    expect(fallback()).toHaveTextContent(STOCK_URL);
    expect(error).toHaveBeenCalledWith(
      "[discord-activity] openExternalLink failed:",
      expect.any(Error),
    );
  });

  it("offers the address to copy when the command throws rather than rejects", async () => {
    const error = jest
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    mockOpenExternalLink.mockImplementation(() => {
      throw new Error("thrown");
    });
    renderActivity();
    fireEvent.click(openButton());
    await settle();
    expect(fallback()).toHaveTextContent(STOCK_URL);
    expect(error).toHaveBeenCalledWith(
      "[discord-activity] openExternalLink failed:",
      expect.any(Error),
    );
  });

  it("ignores a second press while the first is on its way out", async () => {
    mockOpenExternalLink.mockReturnValue(new Promise<void>(() => undefined));
    renderActivity();
    fireEvent.click(openButton());
    fireEvent.click(openButton());
    await settle();
    expect(mockOpenExternalLink).toHaveBeenCalledTimes(1);
  });

  it("does not hold the Open button busy for good when Discord never answers", async () => {
    jest.useFakeTimers();
    mockOpenExternalLink.mockReturnValue(new Promise<void>(() => undefined));
    renderActivity();
    fireEvent.click(openButton());
    await settle();
    expect(openButton()).toHaveAttribute("aria-busy", "true");

    // LINK_SETTLE_MS: long past any honest answer from Discord.
    act(() => {
      jest.advanceTimersByTime(10_000);
    });
    await settle();
    expect(openButton()).not.toHaveAttribute("aria-busy");
    fireEvent.click(openButton());
    await settle();
    expect(mockOpenExternalLink).toHaveBeenCalledTimes(2);
  });

  it("catches a middle click on a link in the page, and leaves a right click's menu alone", async () => {
    renderActivity();
    const link = document.createElement("a");
    link.href = "/shorts/BHP";
    link.textContent = "BHP";
    document.body.appendChild(link);

    const middle = new MouseEvent("auxclick", {
      bubbles: true,
      cancelable: true,
      button: 1,
    });
    link.dispatchEvent(middle);
    expect(middle.defaultPrevented).toBe(true);
    await settle();
    expect(mockOpenExternalLink).toHaveBeenCalledWith({
      url: "https://shorted.com.au/shorts/BHP",
    });

    const right = new MouseEvent("auxclick", {
      bubbles: true,
      cancelable: true,
      button: 2,
    });
    link.dispatchEvent(right);
    expect(right.defaultPrevented).toBe(false);
    link.remove();
  });
});

describe("the copy-link fallback, and which control shows a link on its way out", () => {
  it("marks only the control pressed as busy: a sign-in on its way out leaves Open on Shorted idle", async () => {
    mockOpenExternalLink.mockReturnValue(new Promise<void>(() => undefined));
    renderActivity();
    fireEvent.click(screen.getByRole("button", { name: /^Indicators/ }));
    fireEvent.click(screen.getByRole("button", { name: "Sign in on Shorted" }));
    await settle();
    expect(mockOpenExternalLink).toHaveBeenCalledWith({ url: SIGN_IN_URL });
    expect(openButton()).not.toHaveAttribute("aria-busy");
    expect(openButton().querySelector(".animate-spin")).toBeNull();

    // One link at a time, across the controls: Open does not send a second one.
    fireEvent.click(openButton());
    await settle();
    expect(mockOpenExternalLink).toHaveBeenCalledTimes(1);
  });

  it("shows the sign-in button busy while its link is out, and leaves Open on Shorted idle", async () => {
    mockOpenExternalLink.mockReturnValue(new Promise<void>(() => undefined));
    renderActivity();
    fireEvent.click(screen.getByRole("button", { name: /^Indicators/ }));
    fireEvent.click(screen.getByRole("button", { name: "Sign in on Shorted" }));
    await settle();
    expect(mockOpenExternalLink).toHaveBeenCalledWith({ url: SIGN_IN_URL });
    expect(
      screen.getByRole("button", { name: "Sign in on Shorted" }),
    ).toHaveAttribute("aria-busy", "true");
    expect(openButton()).not.toHaveAttribute("aria-busy");
  });

  it("clears the copy-link fallback when a later open goes out", async () => {
    jest.useFakeTimers();
    let connect: () => void = () => undefined;
    mockReady.mockReturnValue(
      new Promise<void>((resolve) => {
        connect = () => resolve();
      }),
    );
    renderActivity();
    fireEvent.click(openButton());
    act(() => {
      jest.advanceTimersByTime(3_000);
    });
    await settle();
    expect(fallback()).toHaveTextContent(STOCK_URL);

    // The SDK connects, and the next press gets the address out.
    connect();
    await settle();
    fireEvent.click(openButton());
    await settle();
    expect(mockOpenExternalLink).toHaveBeenCalledTimes(1);
    expect(mockOpenExternalLink).toHaveBeenCalledWith({ url: STOCK_URL });
    expect(fallback()).toBeNull();
  });

  it("clears the copy-link fallback when the reader switches stock", async () => {
    jest.useFakeTimers();
    mockReady.mockReturnValue(new Promise<void>(() => undefined));
    renderActivity();
    fireEvent.click(openButton());
    act(() => {
      jest.advanceTimersByTime(3_000);
    });
    await settle();
    expect(fallback()).toHaveTextContent(STOCK_URL);

    await pickStock("bhp");
    expect(fallback()).toBeNull();
  });

  it("shows no fallback for a link that settles after the reader has moved to another stock", async () => {
    jest.useFakeTimers();
    mockReady.mockReturnValue(new Promise<void>(() => undefined));
    renderActivity();
    fireEvent.click(openButton());
    act(() => {
      jest.advanceTimersByTime(1_000);
    });
    await settle();
    // The switch comes before the SDK wait ends, so the CBA link is stale when it does.
    await pickStock("bhp");
    act(() => {
      jest.advanceTimersByTime(3_000);
    });
    await settle();
    expect(screen.getByText("BHP")).toBeInTheDocument();
    expect(fallback()).toBeNull();
    expect(mockOpenExternalLink).not.toHaveBeenCalled();
  });

  it("lets the new stock's Open go out at once: a switch releases the old stock's link", async () => {
    jest.useFakeTimers();
    mockReady.mockReturnValue(new Promise<void>(() => undefined));
    renderActivity();
    fireEvent.click(openButton());
    await settle();
    await pickStock("bhp");
    // The embed remounts for the new stock, so the button is looked up again.
    const bhpOpen = screen.getByRole("button", {
      name: "Open BHP on Shorted",
    });
    fireEvent.click(bhpOpen);
    await settle();
    expect(bhpOpen).toHaveAttribute("aria-busy", "true");
  });

  it("leaves the new stock's busy state alone when the old stock's link settles", async () => {
    jest.useFakeTimers();
    mockReady.mockReturnValue(new Promise<void>(() => undefined));
    renderActivity();
    // CBA's link starts at 0 and would end at 3s; the switch and BHP's link start at 1s.
    fireEvent.click(openButton());
    act(() => {
      jest.advanceTimersByTime(1_000);
    });
    await settle();
    await pickStock("bhp");
    const bhpOpen = screen.getByRole("button", {
      name: "Open BHP on Shorted",
    });
    fireEvent.click(bhpOpen);
    await settle();
    // CBA's wait ends at 3s, and it reports nothing. BHP's own wait runs to 4s.
    act(() => {
      jest.advanceTimersByTime(2_000);
    });
    await settle();
    expect(bhpOpen).toHaveAttribute("aria-busy", "true");
    act(() => {
      jest.advanceTimersByTime(1_000);
    });
    await settle();
    expect(bhpOpen).not.toHaveAttribute("aria-busy");
    expect(fallback()).toHaveTextContent("shorted.com.au/shorts/BHP");
  });

  it("treats a pick of the stock already on screen as no switch: a pending Open still shows its fallback", async () => {
    jest.useFakeTimers();
    mockReady.mockReturnValue(new Promise<void>(() => undefined));
    renderActivity();
    fireEvent.click(openButton());
    await settle();
    expect(openButton()).toHaveAttribute("aria-busy", "true");

    // The reader searches for CBA, the stock on screen, and picks it. The chart does not
    // remount, so the Open still waiting for the SDK keeps its busy state and its wait.
    await pickStock("cba");
    expect(openButton()).toHaveAttribute("aria-busy", "true");

    act(() => {
      jest.advanceTimersByTime(3_000);
    });
    await settle();
    expect(fallback()).toHaveTextContent(STOCK_URL);
    expect(screen.getByRole("status")).toHaveTextContent(
      "Copy it into your browser",
    );
    expect(mockOpenExternalLink).not.toHaveBeenCalled();
  });

  it("a pick of the stock already on screen keeps the one-link guard: the link goes out once", async () => {
    let connect: () => void = () => undefined;
    mockReady.mockReturnValue(
      new Promise<void>((resolve) => {
        connect = resolve;
      }),
    );
    renderActivity();
    fireEvent.click(openButton());
    await settle();
    await pickStock("cba");

    // A second press while the first link is still on its way out sends nothing more.
    fireEvent.click(openButton());
    await settle();
    connect();
    await settle();
    expect(mockOpenExternalLink).toHaveBeenCalledTimes(1);
    expect(mockOpenExternalLink).toHaveBeenCalledWith({ url: STOCK_URL });
    expect(fallback()).toBeNull();
  });
});

describe("the chart inside Discord", () => {
  it("keeps the reader's landscape choice across a stock switch, even with the keyboard up", async () => {
    renderActivity();
    // A phone's own launch starts turned sideways.
    expect(landscapeBox()).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Back to portrait" }));
    expect(landscapeBox()).toBeNull();
    await pickStock("bhp");
    expect(screen.getByText("BHP")).toBeInTheDocument();
    expect(landscapeBox()).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "Rotate chart to landscape" }),
    );
    // While the search's on-screen keyboard is up, the screen reads as landscape. The
    // chart must not re-read the screen at the switch, so the choice holds.
    portrait = false;
    await pickStock("wbc");
    expect(screen.getByText("WBC")).toBeInTheDocument();
    expect(landscapeBox()).not.toBeNull();
  });

  it("draws the search dialog upright over the turned chart, never inside it", () => {
    renderActivity();
    expect(landscapeBox()).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Search stocks" }));
    const dialog = screen.getByRole("dialog", { name: "Search ASX stocks" });
    // Portalled to the body: a dialog inside the rotated box would be placed sideways.
    expect(dialog.parentElement).toBe(document.body);
    expect(landscapeBox()).not.toContainElement(dialog);
  });

  it("returns focus to the Search button when the dialog closes, and to the new chart's after a pick", async () => {
    renderActivity();
    const search = screen.getByRole("button", { name: "Search stocks" });
    search.focus();
    fireEvent.click(search);
    const input = screen.getByRole("searchbox", { name: "Search ASX stocks" });
    await waitFor(() => expect(input).toHaveFocus());

    fireEvent.keyDown(input, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Search stocks" }),
      ).toHaveFocus(),
    );

    // A pick remounts the chart, and its Search button is a new element.
    await pickStock("bhp");
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Search stocks" }),
      ).toHaveFocus(),
    );
  });

  it("offers the indicators with no anchor in the frame, the advanced ones behind a sign-in button", () => {
    renderActivity();
    fireEvent.click(screen.getByRole("button", { name: /^Indicators/ }));
    expect(screen.getByText("SMA 200")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Sign in on Shorted" }),
    ).toBeInTheDocument();
    expect(document.querySelectorAll("a")).toHaveLength(0);
  });

  it("sends the sign-in out once: a second press while it is on its way out opens nothing more", async () => {
    mockOpenExternalLink.mockReturnValue(new Promise<void>(() => undefined));
    renderActivity();
    fireEvent.click(screen.getByRole("button", { name: /^Indicators/ }));
    const signIn = screen.getByRole("button", { name: "Sign in on Shorted" });
    fireEvent.click(signIn);
    fireEvent.click(signIn);
    await settle();
    expect(mockOpenExternalLink).toHaveBeenCalledTimes(1);
    expect(mockOpenExternalLink).toHaveBeenCalledWith({ url: SIGN_IN_URL });
    expect(document.querySelectorAll("a")).toHaveLength(0);
  });
});
