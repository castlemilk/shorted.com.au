import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

    render(
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

    render(
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

    render(
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
