const mockAuth = jest.fn();
jest.mock("~/server/auth", () => ({ auth: () => mockAuth() }));

const mockLookup = jest.fn();
jest.mock("~/server/account-verification", () => ({
  lookupAccountVerification: (uid: string) => mockLookup(uid),
}));

const mockConsume = jest.fn();
const mockSendLink = jest.fn();
jest.mock("~/server/email-verification", () => ({
  consumeVerificationSend: (uid: string) => mockConsume(uid),
  sendVerificationEmail: (email: string) => mockSendLink(email),
}));

import { sendAlertVerificationEmail } from "../email-verification";

const SIGNED_IN = { user: { id: "uid-1", email: "trader@example.com" } };
const PASSWORD_ACCOUNT = {
  email: "trader@example.com",
  verified: false,
  hasPassword: true,
};

beforeEach(() => {
  mockAuth.mockReset();
  mockLookup.mockReset();
  mockConsume.mockReset();
  mockSendLink.mockReset();
  mockAuth.mockResolvedValue(SIGNED_IN);
  mockLookup.mockResolvedValue(PASSWORD_ACCOUNT);
  mockConsume.mockResolvedValue({ ok: true });
  mockSendLink.mockResolvedValue(true);
});

describe("sendAlertVerificationEmail", () => {
  it("asks the caller to sign in when there is no session", async () => {
    mockAuth.mockResolvedValue(null);

    const result = await sendAlertVerificationEmail();

    expect(result).toEqual({
      ok: false,
      error: "Sign in to verify your email.",
    });
    expect(mockLookup).not.toHaveBeenCalled();
    expect(mockSendLink).not.toHaveBeenCalled();
  });

  it("reads the account from Firebase, not the session, before deciding", async () => {
    await sendAlertVerificationEmail();
    expect(mockLookup).toHaveBeenCalledWith("uid-1");
  });

  it("refuses when the account has no usable address", async () => {
    mockLookup.mockResolvedValue(null);

    const result = await sendAlertVerificationEmail();

    expect(result).toMatchObject({ ok: false });
    expect(mockSendLink).not.toHaveBeenCalled();
  });

  it("reports an already-verified account and sends nothing", async () => {
    mockLookup.mockResolvedValue({ ...PASSWORD_ACCOUNT, verified: true });

    const result = await sendAlertVerificationEmail();

    expect(result).toEqual({ ok: true, status: "already-verified" });
    expect(mockConsume).not.toHaveBeenCalled();
    expect(mockSendLink).not.toHaveBeenCalled();
  });

  it("refuses an account that signs in another way, which has no password to verify", async () => {
    mockLookup.mockResolvedValue({ ...PASSWORD_ACCOUNT, hasPassword: false });

    const result = await sendAlertVerificationEmail();

    expect(result).toMatchObject({ ok: false });
    expect(mockSendLink).not.toHaveBeenCalled();
  });

  it("is rate-limited, reports the wait, and sends nothing", async () => {
    mockConsume.mockResolvedValue({ ok: false, retryAfterSeconds: 45 });

    const result = await sendAlertVerificationEmail();

    expect(result).toEqual({
      ok: false,
      error: "You have asked for several emails. Try again shortly.",
      retryAfterSeconds: 45,
    });
    expect(mockConsume).toHaveBeenCalledWith("uid-1");
    expect(mockSendLink).not.toHaveBeenCalled();
  });

  it("reports a failed send without claiming success", async () => {
    mockSendLink.mockResolvedValue(false);

    const result = await sendAlertVerificationEmail();

    expect(result).toEqual({
      ok: false,
      error: "Could not send the email. Try again shortly.",
    });
  });

  it("sends to the Firebase address and reports sent", async () => {
    const result = await sendAlertVerificationEmail();

    expect(mockSendLink).toHaveBeenCalledWith("trader@example.com");
    expect(result).toEqual({ ok: true, status: "sent" });
  });
});
