import { render, screen } from "@testing-library/react";
import { useSession } from "next-auth/react";

import { RateLimitError } from "../rate-limit-error";

const mockUseSession = useSession as unknown as jest.Mock;

describe("RateLimitError", () => {
  beforeEach(() => {
    mockUseSession.mockReturnValue({
      data: null,
      status: "unauthenticated",
      update: jest.fn(),
    });
    window.history.pushState({}, "", "/shorts/BHP?tab=chat");
  });

  it("directs anonymous users to sign in for higher rate limits", () => {
    render(
      <RateLimitError
        compact
        rateLimitInfo={{
          isRateLimited: true,
          limit: 600,
          retryAfter: 30,
        }}
      />,
    );

    expect(
      screen.getByText(/sign in to get a larger request bucket/i),
    ).toBeInTheDocument();

    expect(
      screen.getByRole("link", { name: /sign in for higher limits/i }),
    ).toHaveAttribute(
      "href",
      "/signin?callbackUrl=%2Fshorts%2FBHP%3Ftab%3Dchat",
    );
  });
});
