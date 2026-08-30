import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const mockApprove = jest.fn();
const mockDeny = jest.fn();

jest.mock("../actions", () => ({
  approveAuthorization: (...args: unknown[]) => mockApprove(...args) as unknown,
  denyAuthorization: (...args: unknown[]) => mockDeny(...args) as unknown,
}));

import { ConsentScreen } from "../consent-screen";
import type { AuthorizationRequest, ConsentDescribeResult } from "../actions";

const request: AuthorizationRequest = {
  clientId: "client-abc",
  redirectUri: "http://127.0.0.1:51763/callback",
  codeChallenge: "challenge",
  codeChallengeMethod: "S256",
  resource: "https://api.test/mcp",
  scope: "shorts:read housing:read",
  state: "opaque-state",
};

const described: ConsentDescribeResult = {
  ok: true,
  details: {
    issuer: "https://api.test",
    clientId: "client-abc",
    clientName: "Claude Desktop",
    redirectUri: "http://127.0.0.1:51763/callback",
    scope: "shorts:read housing:read",
    scopes: [
      { scope: "shorts:read", description: "Read short positions" },
      { scope: "housing:read", description: "Read house prices" },
    ],
  },
};

function renderScreen(overrides?: Partial<{ described: ConsentDescribeResult }>) {
  return render(
    <ConsentScreen
      request={request}
      described={overrides?.described ?? described}
      userEmail="a@example.test"
    />,
  );
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("the consent screen", () => {
  // The three facts a human needs to decide. Any one missing turns this from a
  // decision into a formality.
  it("names the client, the scopes and the destination", () => {
    renderScreen();
    expect(screen.getByText(/Claude Desktop/)).toBeInTheDocument();
    expect(screen.getByText(/Read short positions/)).toBeInTheDocument();
    expect(screen.getByText(/Read house prices/)).toBeInTheDocument();
    expect(
      screen.getByText("http://127.0.0.1:51763/callback"),
    ).toBeInTheDocument();
  });

  // An auto-approving screen is the thing this task exists to not build.
  it("approves only on an explicit action", () => {
    renderScreen();
    expect(mockApprove).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: /approve/i }),
    ).toBeInTheDocument();
  });

  it("sends the human to the returned destination on approve", async () => {
    mockApprove.mockResolvedValue({
      ok: true,
      redirectTo: "http://127.0.0.1:51763/callback?code=abc",
    });
    const assign = jest.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { set href(value: string) { assign(value); } },
    });

    renderScreen();
    await userEvent.click(screen.getByRole("button", { name: /approve/i }));

    await waitFor(() => {
      expect(assign).toHaveBeenCalledWith(
        "http://127.0.0.1:51763/callback?code=abc",
      );
    });
  });

  it("takes the deny path on cancel", async () => {
    mockDeny.mockResolvedValue({ ok: true, redirectTo: "http://127.0.0.1:51763/callback?error=access_denied" });
    renderScreen();
    await userEvent.click(screen.getByRole("button", { name: /cancel/i }));
    await waitFor(() => expect(mockDeny).toHaveBeenCalledWith(request));
    expect(mockApprove).not.toHaveBeenCalled();
  });

  it("shows a failure instead of pretending it worked", async () => {
    mockApprove.mockResolvedValue({
      ok: false,
      error: "access_denied",
      description: "the consent ticket is not valid",
    });
    renderScreen();
    await userEvent.click(screen.getByRole("button", { name: /approve/i }));
    expect(
      await screen.findByText(/the consent ticket is not valid/),
    ).toBeInTheDocument();
  });

  // Rendering an Approve button over a request the server will not honour
  // teaches people to click through errors.
  it("offers no decision at all for a refused request", () => {
    renderScreen({
      described: {
        ok: false,
        error: "invalid_client",
        description: "unknown client_id",
      },
    });
    expect(screen.queryByRole("button", { name: /approve/i })).toBeNull();
    expect(screen.getByText(/unknown client_id/)).toBeInTheDocument();
  });
});
