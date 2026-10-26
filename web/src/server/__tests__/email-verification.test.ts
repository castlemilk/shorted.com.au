const mockGenerateLink = jest.fn();
jest.mock("~/@/lib/firebase-admin", () => ({
  adminAuth: {
    generateEmailVerificationLink: (...args: unknown[]) =>
      mockGenerateLink(...args),
  },
}));

const mockConsumeRateLimit = jest.fn();
jest.mock("~/@/lib/rate-limit", () => ({
  consumeRateLimit: (...args: unknown[]) => mockConsumeRateLimit(...args),
}));

const mockSendResend = jest.fn();
jest.mock("~/@/lib/resend-email", () => ({
  sendResendEmail: (...args: unknown[]) => mockSendResend(...args),
}));

import {
  consumeVerificationSend,
  sendVerificationEmail,
  VERIFICATION_SEND_WINDOWS,
} from "../email-verification";

const LINK =
  "https://shorted-prod.firebaseapp.com/__/auth/action?mode=verifyEmail&oobCode=SECRET-CODE";

beforeEach(() => {
  mockGenerateLink.mockReset();
  mockConsumeRateLimit.mockReset();
  mockSendResend.mockReset();
  mockGenerateLink.mockResolvedValue(LINK);
  mockSendResend.mockResolvedValue(true);
});

describe("sendVerificationEmail", () => {
  it("generates a Firebase verification link that returns to the alerts page", async () => {
    await sendVerificationEmail("trader@example.com");

    expect(mockGenerateLink).toHaveBeenCalledWith("trader@example.com", {
      url: "https://shorted.com.au/alerts?verified=1",
    });
  });

  it("mails the link to the address with Resend and reports success", async () => {
    const sent = await sendVerificationEmail("trader@example.com");

    expect(sent).toBe(true);
    expect(mockSendResend).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "trader@example.com",
        text: expect.stringContaining(LINK),
      }),
    );
  });

  it("does not send when the link cannot be generated, and does not log the address", async () => {
    const warn = jest
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    mockGenerateLink.mockRejectedValue(
      Object.assign(new Error("no user record for trader@example.com"), {
        code: "auth/user-not-found",
      }),
    );

    const sent = await sendVerificationEmail("trader@example.com");

    expect(sent).toBe(false);
    expect(mockSendResend).not.toHaveBeenCalled();
    const logged = warn.mock.calls.flat().join(" ");
    expect(logged).toContain("auth/user-not-found");
    expect(logged).not.toContain("trader@example.com");
    warn.mockRestore();
  });

  it("reports a failed Resend send as not sent", async () => {
    mockSendResend.mockResolvedValue(false);
    expect(await sendVerificationEmail("trader@example.com")).toBe(false);
  });
});

describe("consumeVerificationSend", () => {
  it("checks the minute and the day windows against the one user's key", async () => {
    mockConsumeRateLimit.mockResolvedValue({
      success: true,
      retryAfterSeconds: 60,
    });

    const result = await consumeVerificationSend("uid-1");

    expect(result).toEqual({ ok: true });
    expect(mockConsumeRateLimit).toHaveBeenCalledTimes(
      VERIFICATION_SEND_WINDOWS.length,
    );
    for (const window of VERIFICATION_SEND_WINDOWS) {
      expect(mockConsumeRateLimit).toHaveBeenCalledWith(
        "verify-email:uid-1",
        window,
      );
    }
  });

  it("allows one a minute and five a day", () => {
    const byName = Object.fromEntries(
      VERIFICATION_SEND_WINDOWS.map((w) => [w.bucketName, w]),
    );
    expect(byName["verify-email-minute"]).toMatchObject({
      authenticatedLimit: 1,
      windowSeconds: 60,
    });
    expect(byName["verify-email-day"]).toMatchObject({
      authenticatedLimit: 5,
      windowSeconds: 86400,
    });
  });

  it("reports the longest wait when a window is exhausted", async () => {
    mockConsumeRateLimit
      .mockResolvedValueOnce({ success: false, retryAfterSeconds: 60 })
      .mockResolvedValueOnce({ success: false, retryAfterSeconds: 3600 });

    expect(await consumeVerificationSend("uid-1")).toEqual({
      ok: false,
      retryAfterSeconds: 3600,
    });
  });
});
