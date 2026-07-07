import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { StockTabs } from "../../stock-tabs";
import { CommunityTab } from "../community-tab";
import { useSession } from "next-auth/react";

jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ children, href, ...props }: any) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

jest.mock("../../stock-verdict", () => ({
  StockVerdict: () => <div data-testid="stock-verdict" />,
}));

jest.mock("../../company-tax-card", () => ({
  CompanyTaxCard: () => <div data-testid="company-tax-card" />,
}));

jest.mock("../../stock-signals", () => ({
  StockSignals: () => <div data-testid="stock-signals" />,
}));

jest.mock("../../stock-connections", () => ({
  StockConnections: () => <div data-testid="stock-connections" />,
}));

jest.mock("../../stock-news-feed", () => ({
  StockNewsFeed: () => <div data-testid="stock-news-feed" />,
}));

jest.mock("../../related-news-rail", () => ({
  RelatedNewsRail: () => <div data-testid="related-news-rail" />,
}));

jest.mock("../../event-timeline", () => ({
  EventTimeline: () => <div data-testid="event-timeline" />,
}));

jest.mock("../../director-trades-table", () => ({
  DirectorTradesTable: () => <div data-testid="director-trades-table" />,
}));

jest.mock("../../dividend-history", () => ({
  DividendHistory: () => <div data-testid="dividend-history" />,
}));

jest.mock("../../peer-comparison-table", () => ({
  PeerComparisonTable: () => <div data-testid="peer-comparison-table" />,
}));

function renderWithQueryClient(ui: ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });

  return render(
    <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>,
  );
}

describe("StockTabs community integration", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (useSession as jest.Mock).mockReturnValue({
      data: {
        user: {
          id: "user-123",
          name: "Test User",
          email: "test@example.com",
        },
      },
      status: "authenticated",
    });
    global.fetch = jest.fn();
  });

  it("renders the Community trigger and displays community content when selected", async () => {
    const user = userEvent.setup();

    renderWithQueryClient(
      <StockTabs
        stockCode="BHP"
        overviewContent={<div>Overview content</div>}
        financialsContent={<div>Financials content</div>}
        communityContent={
          <CommunityTab
            stockCode="BHP"
            threads={[
              {
                id: "thread-1",
                stockCode: "BHP",
                type: "bull",
                title: "Iron ore resilience still matters",
                body: "Three broker notes are pointing at the same setup.",
                score: 8,
                commentCount: 5,
                sourceCount: 3,
                highSignal: true,
                createdAt: new Date("2026-04-10T08:00:00Z"),
                updatedAt: new Date("2026-04-10T08:00:00Z"),
                lastActivityAt: new Date("2026-04-10T08:00:00Z"),
              },
            ]}
            pulse={[
              {
                id: "pulse-1",
                stockCode: "BHP",
                body: "Desk chatter shifted after the broker downgrade.",
                score: 2,
                replyCount: 1,
                createdAt: new Date("2026-04-11T08:00:00Z"),
                updatedAt: new Date("2026-04-11T08:00:00Z"),
              },
            ]}
          />
        }
      />,
    );

    expect(screen.getByRole("tab", { name: "Community" })).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Community" }));

    expect(screen.getByText("Research Threads")).toBeInTheDocument();
    expect(
      screen.getByText("Iron ore resilience still matters"),
    ).toBeInTheDocument();
    expect(screen.getByText("Live Pulse")).toBeInTheDocument();
    expect(
      screen.getByText(/Desk chatter shifted after the broker downgrade/i),
    ).toBeInTheDocument();
  });

  it("shows a sign-in CTA instead of posting controls when signed out", async () => {
    const user = userEvent.setup();
    (useSession as jest.Mock).mockReturnValue({
      data: null,
      status: "unauthenticated",
    });

    renderWithQueryClient(
      <StockTabs
        stockCode="BHP"
        overviewContent={<div>Overview content</div>}
        communityContent={<CommunityTab stockCode="BHP" threads={[]} pulse={[]} />}
      />,
    );

    await user.click(screen.getByRole("tab", { name: "Community" }));

    expect(
      screen.getByRole("link", { name: /sign in to post/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /start a thread/i }),
    ).not.toBeInTheDocument();
  });

  it("loads threads and pulse from the community APIs when initial lists are omitted", async () => {
    const user = userEvent.setup();
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          threads: [
            {
              id: "thread-from-api",
              stockCode: "BHP",
              type: "bear",
              title: "Borrow remains tight",
              body: "The borrow setup is still worth tracking.",
              score: 3,
              commentCount: 2,
              sourceCount: 1,
              highSignal: false,
              createdAt: "2026-04-10T08:00:00Z",
              updatedAt: "2026-04-10T08:00:00Z",
              lastActivityAt: "2026-04-10T09:00:00Z",
              status: "active",
            },
          ],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          pulse: [
            {
              id: "pulse-from-api",
              stockCode: "BHP",
              body: "Fresh note just crossed the tape.",
              score: 4,
              replyCount: 0,
              createdAt: "2026-04-11T08:00:00Z",
              updatedAt: "2026-04-11T08:00:00Z",
              status: "active",
            },
          ],
        }),
      });

    render(
      <StockTabs
        stockCode="BHP"
        overviewContent={<div>Overview content</div>}
        communityContent={<CommunityTab stockCode="BHP" />}
      />,
    );

    expect(global.fetch).not.toHaveBeenCalled();

    await user.click(screen.getByRole("tab", { name: "Community" }));

    expect(global.fetch).toHaveBeenCalledWith("/api/community/BHP/threads", {
      signal: expect.any(AbortSignal),
    });
    expect(global.fetch).toHaveBeenCalledWith("/api/community/BHP/pulse", {
      signal: expect.any(AbortSignal),
    });
    expect(await screen.findByText("Borrow remains tight")).toBeInTheDocument();
    expect(
      await screen.findByText(/Fresh note just crossed the tape/i),
    ).toBeInTheDocument();
  });

  it("lets an authenticated user open the composer and append a new thread locally", async () => {
    const user = userEvent.setup();
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({
        thread: {
          id: "thread-2",
          stockCode: "BHP",
          type: "bull",
          title: "New conviction thread",
          body: "The risk-reward is turning cleaner after the washout.",
          score: 0,
          commentCount: 0,
          sourceCount: 0,
          highSignal: false,
          createdAt: new Date("2026-04-11T09:00:00Z"),
          updatedAt: new Date("2026-04-11T09:00:00Z"),
          lastActivityAt: new Date("2026-04-11T09:00:00Z"),
          status: "active",
        },
      }),
    });

    renderWithQueryClient(
      <StockTabs
        stockCode="BHP"
        overviewContent={<div>Overview content</div>}
        communityContent={<CommunityTab stockCode="BHP" threads={[]} pulse={[]} />}
      />,
    );

    await user.click(screen.getByRole("tab", { name: "Community" }));
    expect(screen.getByRole("button", { name: /start a thread/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /drop a pulse/i })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /start a thread/i }));
    await user.type(screen.getByLabelText(/thread title/i), "New conviction thread");
    await user.type(
      screen.getByLabelText(/thread body/i),
      "The risk-reward is turning cleaner after the washout.",
    );
    await user.click(screen.getByRole("button", { name: /post thread/i }));

    expect(
      await screen.findByText("New conviction thread"),
    ).toBeInTheDocument();
  });
});
