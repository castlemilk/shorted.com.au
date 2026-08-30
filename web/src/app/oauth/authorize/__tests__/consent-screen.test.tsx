import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// next/image needs a base URL its loader can resolve, which jsdom does not
// provide. Mocked the same way state-companies.test.tsx does it.
jest.mock("next/image", () => ({
  __esModule: true,
  // eslint-disable-next-line @next/next/no-img-element, jsx-a11y/alt-text
  default: (props: { src: string; alt?: string }) => (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={props.src} alt={props.alt ?? ""} />
  ),
}));

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

function renderScreen(
  overrides?: Partial<{ described: ConsentDescribeResult }>,
) {
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

  // The redirect is deliberately held for a beat so the confirmation is
  // actually seen — without it the browser leaves within a frame and the user
  // never learns anything happened. This asserts BOTH halves: the screen shows
  // first, and the navigation still follows.
  it("shows the confirmation, then sends the human to the destination", async () => {
    mockApprove.mockResolvedValue({
      ok: true,
      redirectTo: "http://127.0.0.1:51763/callback?code=abc",
    });
    const assign = jest.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: {
        set href(value: string) {
          assign(value);
        },
      },
    });

    renderScreen();
    await userEvent.click(screen.getByRole("button", { name: /approve/i }));

    // The confirmation is on screen before the browser goes anywhere.
    expect(
      await screen.findByText(/successfully authenticated/i),
    ).toBeInTheDocument();
    expect(assign).not.toHaveBeenCalled();

    // And the navigation still happens.
    await waitFor(
      () => {
        expect(assign).toHaveBeenCalledWith(
          "http://127.0.0.1:51763/callback?code=abc",
        );
      },
      { timeout: 4000 },
    );
  });

  it("takes the deny path on cancel", async () => {
    mockDeny.mockResolvedValue({
      ok: true,
      redirectTo: "http://127.0.0.1:51763/callback?error=access_denied",
    });
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

// ---------------------------------------------------------------------------
// The handoff
// ---------------------------------------------------------------------------
//
// Approving used to set window.location and hope. The destination is almost
// always a loopback listener on the user's own machine, and if it is gone — the
// app crashed, the user closed it, the flow sat too long — the browser lands on
// a raw connection error with no explanation. We cannot detect that from our
// origin; it is a cross-origin navigation. So the screen says what is
// happening and leaves a way forward behind it.

describe("the handoff after a decision", () => {
  function stubLocation() {
    const assign = jest.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: {
        set href(value: string) {
          assign(value);
        },
      },
    });
    return assign;
  }

  it("tells the human what happened and where they are going", async () => {
    mockApprove.mockResolvedValue({
      ok: true,
      redirectTo: "http://127.0.0.1:51763/callback?code=abc",
    });
    stubLocation();

    renderScreen();
    await userEvent.click(screen.getByRole("button", { name: /approve/i }));

    expect(
      await screen.findByText(/successfully authenticated/i),
    ).toBeInTheDocument();
    // Named, so the user can tell they are going back to the app they started
    // from rather than somewhere unexpected.
    expect(screen.getAllByText(/Claude Desktop/).length).toBeGreaterThan(0);
  });

  // The escape hatch. Without it, a dead listener strands the user on a browser
  // error page with no way to retry and no idea what went wrong.
  it("leaves a manual link and an explanation behind the redirect", async () => {
    mockApprove.mockResolvedValue({
      ok: true,
      redirectTo: "http://127.0.0.1:51763/callback?code=abc",
    });
    stubLocation();

    renderScreen();
    await userEvent.click(screen.getByRole("button", { name: /approve/i }));

    const link = await screen.findByRole("link", { name: /continue to/i });
    // A real anchor to the SAME url the redirect used — not a button that
    // re-runs the flow, because the code has been issued and is single-use.
    expect(link).toHaveAttribute(
      "href",
      "http://127.0.0.1:51763/callback?code=abc",
    );
    // The wording is now a footnote rather than a panel, but the property is
    // the same: a way forward stays on screen behind the redirect.
    expect(screen.getByText(/not redirected/i)).toBeInTheDocument();
  });

  // The celebration is scoped to APPROVAL. Firing confetti at someone who just
  // declined reads as sarcasm, and what matters on that path is the
  // reassurance that nothing was shared.
  it("celebrates an approval and stays sober on a refusal", async () => {
    mockApprove.mockResolvedValue({
      ok: true,
      redirectTo: "http://127.0.0.1:51763/callback?code=abc",
    });
    stubLocation();
    const { unmount } = renderScreen();
    await userEvent.click(screen.getByRole("button", { name: /approve/i }));
    expect(await screen.findByText(/burn it all down/i)).toBeInTheDocument();
    unmount();

    mockDeny.mockResolvedValue({
      ok: true,
      redirectTo: "http://127.0.0.1:51763/callback?error=access_denied",
    });
    stubLocation();
    renderScreen();
    await userEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(await screen.findByText(/request cancelled/i)).toBeInTheDocument();
    expect(screen.queryByText(/burn it all down/i)).toBeNull();
  });

  // The fire is decoration. It must not be announced to a screen reader, and
  // the meaning has to live in the copy beside it.
  it("keeps the decoration out of the accessibility tree", async () => {
    mockApprove.mockResolvedValue({
      ok: true,
      redirectTo: "http://127.0.0.1:51763/callback?code=abc",
    });
    stubLocation();
    const { container } = renderScreen();
    await userEvent.click(screen.getByRole("button", { name: /approve/i }));
    await screen.findByText(/burn it all down/i);

    const fire = container.querySelector(".ascii-fire");
    expect(fire).not.toBeNull();
    expect(fire).toHaveAttribute("aria-hidden", "true");
    // The state is still stated in words, not implied by the picture.
    expect(screen.getByText(/successfully authenticated/i)).toBeInTheDocument();
  });

  // Cancelling is also a handoff — the client is told, at its registered URI.
  // Saying "nothing was shared" is the reassurance the moment calls for.
  it("says plainly that nothing was shared when cancelled", async () => {
    mockDeny.mockResolvedValue({
      ok: true,
      redirectTo: "http://127.0.0.1:51763/callback?error=access_denied",
    });
    stubLocation();

    renderScreen();
    await userEvent.click(screen.getByRole("button", { name: /cancel/i }));

    expect(await screen.findByText(/request cancelled/i)).toBeInTheDocument();
    expect(screen.getByText(/nothing was shared/i)).toBeInTheDocument();
  });

  // A failure must NOT reach the handoff state — that would tell the user they
  // were approved when they were not.
  it("stays on the decision screen when the server refuses", async () => {
    mockApprove.mockResolvedValue({
      ok: false,
      error: "access_denied",
      description: "the consent ticket is not valid",
    });
    stubLocation();

    renderScreen();
    await userEvent.click(screen.getByRole("button", { name: /approve/i }));

    expect(
      await screen.findByText(/the consent ticket is not valid/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/successfully authenticated/i)).toBeNull();
    // And the buttons come back, so the human can retry or cancel.
    expect(screen.getByRole("button", { name: /approve/i })).toBeEnabled();
  });
});
