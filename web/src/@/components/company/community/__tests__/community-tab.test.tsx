import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StockTabs } from "../../stock-tabs";
import { CommunityTab } from "../community-tab";

jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ children, href, ...props }: any) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

describe("StockTabs community integration", () => {
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
});
