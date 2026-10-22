import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useSession } from "next-auth/react";
import { CommunityThreadDetail } from "../community-thread-detail";

// next/link with the prefetch prop surfaced as data-prefetch so a test can read
// it (it never reaches the DOM otherwise), as the stock tab bar's tests do.
jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ children, href, prefetch, ...props }: any) => (
    <a href={href} data-prefetch={String(prefetch)} {...props}>
      {children}
    </a>
  ),
}));

describe("CommunityThreadDetail", () => {
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
    // Back goes to the Community route itself, not through a ?tab= hop.
    expect(
      screen.getByRole("link", { name: /back to bhp community/i }),
    ).toHaveAttribute("href", "/shorts/BHP/community");
    expect(
      screen.getByText("Friday delivery numbers matter"),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Broker note" })).toBeInTheDocument();
    expect(screen.getByText("Comments")).toBeInTheDocument();
    expect(
      screen.getByText(/The catalyst timing is tighter than the market thinks/i),
    ).toBeInTheDocument();
  });

  it("turns off Link's own prefetch on the back link to the Community tab", () => {
    // A viewport prefetch would fetch (and, once an hour, generate) the
    // Community tab for a reader who only meant to read this one thread.
    render(
      <CommunityThreadDetail
        thread={{
          id: "thread-3",
          stockCode: "BHP",
          type: "question",
          title: "Does the dividend survive a weaker iron ore price?",
          body: "Looking for a read on the payout ratio from the last two halves.",
          score: 0,
          commentCount: 0,
          sourceCount: 0,
          highSignal: false,
          createdAt: new Date("2026-04-12T08:00:00Z"),
          updatedAt: new Date("2026-04-12T08:00:00Z"),
          lastActivityAt: new Date("2026-04-12T08:00:00Z"),
        }}
        comments={[]}
      />,
    );

    expect(
      screen.getByRole("link", { name: /back to bhp community/i }),
    ).toHaveAttribute("data-prefetch", "false");
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

  it("lets an authenticated user append a new comment locally", async () => {
    const user = userEvent.setup();
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({
        comment: {
          id: "comment-2",
          stockCode: "BHP",
          threadId: "thread-2",
          body: "The downgrade feels fully in the price already.",
          score: 0,
          replyCount: 0,
          createdAt: new Date("2026-04-11T08:30:00Z"),
          updatedAt: new Date("2026-04-11T08:30:00Z"),
          status: "active",
        },
      }),
    });

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

    await user.type(
      screen.getByLabelText(/comment body/i),
      "The downgrade feels fully in the price already.",
    );
    await user.click(screen.getByRole("button", { name: /post comment/i }));

    expect(
      await screen.findByText(/The downgrade feels fully in the price already/i),
    ).toBeInTheDocument();
  });
});

/**
 * A thread's sources are whatever its author typed, and the page linked each
 * one as it came: a `javascript:` source ran in our origin when clicked
 * (security review SEC-07). Only an http(s) source is a link now, and it is
 * marked as user-generated.
 */
describe("CommunityThreadDetail sources", () => {
  beforeEach(() => {
    (useSession as jest.Mock).mockReturnValue({ data: null, status: "unauthenticated" });
    global.fetch = jest.fn();
  });

  function renderWithSources(sources: { label: string; url: string }[]) {
    return render(
      <CommunityThreadDetail
        thread={{
          id: "thread-9",
          stockCode: "BHP",
          type: "catalyst",
          title: "Sources under test",
          body: "Body.",
          score: 0,
          commentCount: 0,
          sourceCount: sources.length,
          highSignal: false,
          createdAt: new Date("2026-04-10T08:00:00Z"),
          updatedAt: new Date("2026-04-10T08:00:00Z"),
          lastActivityAt: new Date("2026-04-10T08:00:00Z"),
          sources,
        }}
        comments={[]}
      />,
    );
  }

  it("links an http(s) source, nofollow and in a new tab", () => {
    renderWithSources([{ label: "Broker note", url: "https://example.com/broker-note" }]);

    const link = screen.getByRole("link", { name: "Broker note" });
    expect(link).toHaveAttribute("href", "https://example.com/broker-note");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link.getAttribute("rel")?.split(" ")).toEqual(
      expect.arrayContaining(["noopener", "noreferrer", "nofollow", "ugc"]),
    );
  });

  it.each([["javascript:alert(document.cookie)"], ["  javascript:alert(1)"], ["data:text/html,<b>x</b>"], ["//evil.example/x"], ["/news/a-relative-path"]])(
    "shows a %p source as its label, not a link",
    (url) => {
      const { container } = renderWithSources([{ label: "Injected", url }]);

      expect(screen.getByText("Injected")).toBeInTheDocument();
      expect(screen.queryByRole("link", { name: "Injected" })).not.toBeInTheDocument();
      expect(container.querySelector(`a[href="${url}"]`)).toBeNull();
    },
  );
});
