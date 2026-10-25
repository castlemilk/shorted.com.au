import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { EmailVerificationPrompt } from "~/@/components/email-verification-prompt";

const mockUseSession = jest.fn();
const mockUpdate = jest.fn();
jest.mock("next-auth/react", () => ({
  useSession: () => mockUseSession(),
}));

const mockSend = jest.fn();
jest.mock("~/app/actions/email-verification", () => ({
  sendAlertVerificationEmail: () => mockSend(),
}));

function session(
  emailVerified: boolean | undefined,
  email = "trader@example.com",
) {
  return {
    data: { user: { id: "u1", email, emailVerified } },
    status: "authenticated",
    update: mockUpdate,
  };
}

const SIGNED_OUT = {
  data: null,
  status: "unauthenticated",
  update: mockUpdate,
};

beforeEach(() => {
  mockUseSession.mockReset();
  mockSend.mockReset();
  mockUpdate.mockReset();
  // Silent check on mount: by default the account is still unverified.
  mockUpdate.mockResolvedValue({ user: { emailVerified: false } });
});

describe("EmailVerificationPrompt", () => {
  it("shows nothing for a verified session", () => {
    mockUseSession.mockReturnValue(session(true));
    const { container } = render(<EmailVerificationPrompt />);
    expect(container).toBeEmptyDOMElement();
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("shows nothing when signed out", () => {
    mockUseSession.mockReturnValue(SIGNED_OUT);
    const { container } = render(<EmailVerificationPrompt />);
    expect(container).toBeEmptyDOMElement();
  });

  it("offers the send and refresh actions to an unverified signed-in account", () => {
    mockUseSession.mockReturnValue(session(false));
    render(<EmailVerificationPrompt />);
    expect(
      screen.getByRole("button", { name: "Send verification email" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "I've verified, refresh" }),
    ).toBeInTheDocument();
  });

  it("treats a session with no verification flag as unverified", () => {
    mockUseSession.mockReturnValue(session(undefined));
    render(<EmailVerificationPrompt />);
    expect(
      screen.getByRole("button", { name: "Send verification email" }),
    ).toBeInTheDocument();
  });

  it("says where the email went, without naming any other account", async () => {
    mockUseSession.mockReturnValue(session(false));
    mockSend.mockResolvedValue({ ok: true, status: "sent" });
    render(<EmailVerificationPrompt />);

    fireEvent.click(
      screen.getByRole("button", { name: "Send verification email" }),
    );

    expect(
      await screen.findByText(
        "Sent. Check your inbox at trader@example.com, then select Refresh here. No sign-out is needed.",
      ),
    ).toBeInTheDocument();
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it("refreshes the session when the send finds the account already verified", async () => {
    mockUseSession.mockReturnValue(session(false));
    mockSend.mockResolvedValue({ ok: true, status: "already-verified" });
    mockUpdate
      .mockResolvedValueOnce({ user: { emailVerified: false } }) // mount check
      .mockResolvedValueOnce({ user: { emailVerified: true } }); // after the send

    render(<EmailVerificationPrompt />);
    fireEvent.click(
      screen.getByRole("button", { name: "Send verification email" }),
    );

    expect(await screen.findByText(/Verified\./)).toBeInTheDocument();
    expect(mockUpdate).toHaveBeenCalledTimes(2);
  });

  it("says how long to wait when the send is rate-limited", async () => {
    mockUseSession.mockReturnValue(session(false));
    mockSend.mockResolvedValue({
      ok: false,
      error: "You have asked for several emails. Try again shortly.",
      retryAfterSeconds: 90,
    });
    render(<EmailVerificationPrompt />);

    fireEvent.click(
      screen.getByRole("button", { name: "Send verification email" }),
    );

    expect(
      await screen.findByText(
        /You have asked for several emails\. Try again shortly\. Try again in 2 minute\(s\)\./,
      ),
    ).toBeInTheDocument();
  });

  it("shows the server's error when the send fails", async () => {
    mockUseSession.mockReturnValue(session(false));
    mockSend.mockResolvedValue({
      ok: false,
      error: "Could not send the email. Try again shortly.",
    });
    render(<EmailVerificationPrompt />);

    fireEvent.click(
      screen.getByRole("button", { name: "Send verification email" }),
    );

    expect(
      await screen.findByText("Could not send the email. Try again shortly."),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Send verification email" }),
    ).not.toBeDisabled();
  });

  it("shows a thrown send as an error rather than failing silently", async () => {
    mockUseSession.mockReturnValue(session(false));
    mockSend.mockRejectedValue(new Error("network"));
    render(<EmailVerificationPrompt />);

    fireEvent.click(
      screen.getByRole("button", { name: "Send verification email" }),
    );

    expect(
      await screen.findByText("Could not send the email. Try again shortly."),
    ).toBeInTheDocument();
  });

  it("flips to verified on refresh without a sign-out", async () => {
    mockUseSession.mockReturnValue(session(false));
    mockUpdate
      .mockResolvedValueOnce({ user: { emailVerified: false } }) // mount check
      .mockResolvedValueOnce({ user: { emailVerified: true } }); // the button

    render(<EmailVerificationPrompt />);
    fireEvent.click(
      screen.getByRole("button", { name: "I've verified, refresh" }),
    );

    expect(await screen.findByText(/Verified\./)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "I've verified, refresh" }),
    ).toBeNull();
    expect(mockUpdate).toHaveBeenCalledTimes(2);
  });

  it("says so when the refresh finds the address still unverified", async () => {
    mockUseSession.mockReturnValue(session(false));
    render(<EmailVerificationPrompt />);

    fireEvent.click(
      screen.getByRole("button", { name: "I've verified, refresh" }),
    );

    expect(
      await screen.findByText(
        "Not verified yet. Open the link in the email, then select Refresh.",
      ),
    ).toBeInTheDocument();
  });

  it("verifies on the silent check when the user has clicked the link since last visit", async () => {
    mockUseSession.mockReturnValue(session(false));
    mockUpdate.mockReset();
    mockUpdate.mockResolvedValue({ user: { emailVerified: true } });

    render(<EmailVerificationPrompt />);

    expect(await screen.findByText(/Verified\./)).toBeInTheDocument();
    expect(mockUpdate).toHaveBeenCalledTimes(1);
  });

  it("adds the intro sentence only when asked", () => {
    mockUseSession.mockReturnValue(session(false));
    const { rerender } = render(<EmailVerificationPrompt />);
    expect(screen.queryByText(/receive alert emails/)).toBeNull();

    rerender(<EmailVerificationPrompt showIntro />);
    expect(screen.getByText(/receive alert emails/)).toHaveTextContent(
      "Verify trader@example.com to receive alert emails.",
    );
  });

  it("does not check Firebase again on re-render", async () => {
    mockUseSession.mockReturnValue(session(false));
    const { rerender } = render(<EmailVerificationPrompt />);
    rerender(<EmailVerificationPrompt />);
    await waitFor(() => expect(mockUpdate).toHaveBeenCalledTimes(1));
  });
});

describe("EmailVerificationPrompt opened from the success page", () => {
  afterEach(() => {
    window.history.pushState({}, "", "/");
  });

  it("is highlighted when the page is opened with ?verify=1", () => {
    window.history.pushState({}, "", "/alerts?verify=1");
    mockUseSession.mockReturnValue(session(false));
    const { container } = render(
      <EmailVerificationPrompt id="email-verification" />,
    );
    expect(container.firstChild).toHaveClass("ring-2");
    expect(container.querySelector("#email-verification")).not.toBeNull();
  });

  it("is not highlighted on an ordinary visit", () => {
    window.history.pushState({}, "", "/alerts");
    mockUseSession.mockReturnValue(session(false));
    const { container } = render(<EmailVerificationPrompt />);
    expect(container.firstChild).not.toHaveClass("ring-2");
  });
});

describe("EmailVerificationPrompt automatic-check failure", () => {
  it("keeps verification actions usable and reports a rejected initial session refresh", async () => {
    mockUseSession.mockReturnValue(session(false));
    mockUpdate.mockRejectedValueOnce(
      new Error("session temporarily unavailable"),
    );
    render(<EmailVerificationPrompt />);

    expect(
      await screen.findByText(
        "Could not check the account. Try again shortly.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Send verification email" }),
    ).toBeEnabled();
    expect(
      screen.getByRole("button", { name: "I've verified, refresh" }),
    ).toBeEnabled();
    expect(mockSend).not.toHaveBeenCalled();
  });
});
