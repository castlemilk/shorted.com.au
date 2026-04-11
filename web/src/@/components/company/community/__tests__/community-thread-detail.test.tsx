import { render, screen } from "@testing-library/react";
import { CommunityThreadDetail } from "../community-thread-detail";

jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ children, href, ...props }: any) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

describe("CommunityThreadDetail", () => {
  it("renders the thread content, source links, and stock back link", () => {
    render(
      <CommunityThreadDetail
        thread={{
          id: "thread-1",
          stockCode: "BHP",
          type: "catalyst",
          title: "Friday delivery numbers matter",
          body: "This is the line item the room is watching.",
          score: 8,
          commentCount: 2,
          sourceCount: 1,
          highSignal: true,
          createdAt: new Date("2026-04-10T08:00:00Z"),
          updatedAt: new Date("2026-04-10T09:00:00Z"),
          lastActivityAt: new Date("2026-04-10T09:00:00Z"),
          sources: [
            {
              label: "Broker note",
              url: "https://example.com/broker-note",
            },
          ],
        }}
        comments={[
          {
            id: "comment-1",
            stockCode: "BHP",
            threadId: "thread-1",
            body: "The catalyst timing is tighter than the market thinks.",
            score: 3,
            replyCount: 0,
            createdAt: new Date("2026-04-10T10:00:00Z"),
            updatedAt: new Date("2026-04-10T10:00:00Z"),
          },
        ]}
      />,
    );

    expect(
      screen.getByRole("link", { name: /back to bhp community/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Friday delivery numbers matter"),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Broker note" })).toBeInTheDocument();
    expect(screen.getByText("Comments")).toBeInTheDocument();
    expect(
      screen.getByText(/The catalyst timing is tighter than the market thinks/i),
    ).toBeInTheDocument();
  });

  it("shows the empty comment shell when there are no comments", () => {
    render(
      <CommunityThreadDetail
        thread={{
          id: "thread-2",
          stockCode: "BHP",
          type: "question",
          title: "Is the latest downgrade already priced in?",
          body: "Trying to work out whether this move has already flushed sentiment.",
          score: 1,
          commentCount: 0,
          sourceCount: 0,
          highSignal: false,
          createdAt: new Date("2026-04-11T08:00:00Z"),
          updatedAt: new Date("2026-04-11T08:00:00Z"),
          lastActivityAt: new Date("2026-04-11T08:00:00Z"),
        }}
        comments={[]}
      />,
    );

    expect(screen.getByText(/no comments yet/i)).toBeInTheDocument();
  });
});
