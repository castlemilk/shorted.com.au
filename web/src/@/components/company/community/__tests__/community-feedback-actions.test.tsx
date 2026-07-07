import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useSession } from "next-auth/react";
import { CommunityFeedbackActions } from "../community-feedback-actions";

describe("CommunityFeedbackActions", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (useSession as jest.Mock).mockReturnValue({
      data: {
        user: {
          id: "user-123",
        },
      },
      status: "authenticated",
    });
    global.fetch = jest.fn().mockResolvedValue({ ok: true });
  });

  it("locks a successful vote so repeated clicks do not create repeated writes", async () => {
    const user = userEvent.setup();
    render(
      <CommunityFeedbackActions
        stockCode="BHP"
        targetType="thread"
        targetId="thread-1"
        initialScore={5}
      />,
    );

    const button = screen.getByRole("button", { name: "Upvote 5" });
    await user.dblClick(button);

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });
    expect(global.fetch).toHaveBeenCalledWith(
      "/api/community/votes",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          stockCode: "BHP",
          targetType: "thread",
          targetId: "thread-1",
          value: 1,
        }),
      }),
    );
    expect(
      await screen.findByRole("button", { name: "Upvoted 6" }),
    ).toBeDisabled();
  });

  it("locks a successful report so repeated clicks do not create repeated writes", async () => {
    const user = userEvent.setup();
    render(
      <CommunityFeedbackActions
        stockCode="BHP"
        targetType="thread"
        targetId="thread-1"
        initialScore={5}
      />,
    );

    const button = screen.getByRole("button", { name: "Report" });
    await user.dblClick(button);

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });
    expect(global.fetch).toHaveBeenCalledWith(
      "/api/community/reports",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          stockCode: "BHP",
          targetType: "thread",
          targetId: "thread-1",
          reason: "user_report",
        }),
      }),
    );
    expect(
      await screen.findByRole("button", { name: "Reported" }),
    ).toBeDisabled();
  });

  it("keeps failed votes retryable", async () => {
    const user = userEvent.setup();
    (global.fetch as jest.Mock).mockResolvedValue({ ok: false });
    render(
      <CommunityFeedbackActions
        stockCode="BHP"
        targetType="thread"
        targetId="thread-1"
        initialScore={5}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Upvote 5" }));

    expect(
      await screen.findByRole("button", { name: "Upvote 5" }),
    ).toBeEnabled();
  });
});
