import { sendResendEmail } from "~/@/lib/resend-email";

const ORIGINAL = {
  key: process.env.RESEND_API_KEY,
  from: process.env.RESEND_FROM,
};

afterEach(() => {
  if (ORIGINAL.key === undefined) delete process.env.RESEND_API_KEY;
  else process.env.RESEND_API_KEY = ORIGINAL.key;
  if (ORIGINAL.from === undefined) delete process.env.RESEND_FROM;
  else process.env.RESEND_FROM = ORIGINAL.from;
});

const EMAIL = { to: "trader@example.com", subject: "s", text: "t" };

describe("sendResendEmail", () => {
  it("is not sent without a configured key, and never calls out", async () => {
    delete process.env.RESEND_API_KEY;
    const fetchImpl = jest.fn();
    expect(
      await sendResendEmail(EMAIL, fetchImpl as unknown as typeof fetch),
    ).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("sends from the verified domain by default, to the one address", async () => {
    process.env.RESEND_API_KEY = "re_test";
    delete process.env.RESEND_FROM;
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true, status: 200 });

    expect(
      await sendResendEmail(EMAIL, fetchImpl as unknown as typeof fetch),
    ).toBe(true);

    const body = JSON.parse(
      (fetchImpl.mock.calls[0][1] as RequestInit).body as string,
    );
    expect(body).toMatchObject({
      from: "Shorted <support@shorted.com.au>",
      to: ["trader@example.com"],
    });
  });

  it("treats a blank From as unset, because Resend rejects an empty one", async () => {
    process.env.RESEND_API_KEY = "re_test";
    process.env.RESEND_FROM = "   ";
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true, status: 200 });

    await sendResendEmail(EMAIL, fetchImpl as unknown as typeof fetch);

    const body = JSON.parse(
      (fetchImpl.mock.calls[0][1] as RequestInit).body as string,
    );
    expect(body.from).toBe("Shorted <support@shorted.com.au>");
  });

  it("reports a rejected send as not sent", async () => {
    process.env.RESEND_API_KEY = "re_test";
    const warn = jest
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    const fetchImpl = jest.fn().mockResolvedValue({ ok: false, status: 422 });

    expect(
      await sendResendEmail(EMAIL, fetchImpl as unknown as typeof fetch),
    ).toBe(false);
    warn.mockRestore();
  });

  it("never throws on a network failure", async () => {
    process.env.RESEND_API_KEY = "re_test";
    const warn = jest
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    const fetchImpl = jest
      .fn()
      .mockRejectedValue(new TypeError("fetch failed"));

    await expect(
      sendResendEmail(EMAIL, fetchImpl as unknown as typeof fetch),
    ).resolves.toBe(false);
    warn.mockRestore();
  });
});
