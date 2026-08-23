/**
 * The operator notifier's contract is mostly about what it must NOT do.
 *
 * It is called from the Stripe webhook. That route returns 500 on an unhandled
 * error, and Stripe RETRIES a 500 — so if this function could throw, a Resend
 * outage would replay subscription grants. Every failure mode below therefore
 * asserts "returns false" rather than "rejects".
 */
import { formatAmount, notifyOperator } from "../operator-notify";

const ORIGINAL_ENV = process.env;

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  jest.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
  jest.restoreAllMocks();
});

const EMAIL = { subject: "s", text: "t" };

describe("notifyOperator", () => {
  it("is a no-op when RESEND_API_KEY is unset, without calling out", async () => {
    delete process.env.RESEND_API_KEY;
    const fetchImpl = jest.fn();
    await expect(notifyOperator(EMAIL, fetchImpl as never)).resolves.toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("treats a whitespace-only key as unset", async () => {
    process.env.RESEND_API_KEY = "   ";
    const fetchImpl = jest.fn();
    await expect(notifyOperator(EMAIL, fetchImpl as never)).resolves.toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("sends with bearer auth and the configured identities", async () => {
    process.env.RESEND_API_KEY = "key_123";
    process.env.RESEND_FROM = "Ops <ops@shorted.com.au>";
    process.env.RESEND_TO = "a@example.com";

    const fetchImpl = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    await expect(notifyOperator(EMAIL, fetchImpl as never)).resolves.toBe(true);

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://api.resend.com/emails");
    expect(init.headers.Authorization).toBe("Bearer key_123");
    const body = JSON.parse(init.body);
    expect(body.from).toBe("Ops <ops@shorted.com.au>");
    expect(body.to).toEqual(["a@example.com"]);
    expect(body.subject).toBe("s");
  });

  it("supports several operator recipients", async () => {
    process.env.RESEND_API_KEY = "k";
    process.env.RESEND_TO = "a@example.com, b@example.com ,";
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    await notifyOperator(EMAIL, fetchImpl as never);
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.to).toEqual(["a@example.com", "b@example.com"]);
  });

  it("falls back to the deployed Go notifier's verified addresses", async () => {
    process.env.RESEND_API_KEY = "k";
    delete process.env.RESEND_FROM;
    delete process.env.RESEND_TO;
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    await notifyOperator(EMAIL, fetchImpl as never);
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    // Must be the Resend-VERIFIED domain. An unverified From is rejected, and
    // this notifier swallows failures, so the breakage would be silent.
    expect(body.from).toBe("Shorted <support@shorted.com.au>");
    expect(body.to).toEqual(["support@shorted.com.au"]);
  });

  // --- the important half: it must never throw ------------------------------

  it("returns false instead of throwing when Resend errors", async () => {
    process.env.RESEND_API_KEY = "k";
    const fetchImpl = jest.fn().mockResolvedValue({ ok: false, status: 422 });
    await expect(notifyOperator(EMAIL, fetchImpl as never)).resolves.toBe(false);
  });

  it("returns false instead of throwing when the network fails", async () => {
    process.env.RESEND_API_KEY = "k";
    const fetchImpl = jest.fn().mockRejectedValue(new Error("ECONNRESET"));
    await expect(notifyOperator(EMAIL, fetchImpl as never)).resolves.toBe(false);
  });

  it("returns false instead of throwing when the send is aborted", async () => {
    process.env.RESEND_API_KEY = "k";
    const abort = new Error("The operation was aborted");
    abort.name = "AbortError";
    const fetchImpl = jest.fn().mockRejectedValue(abort);
    await expect(notifyOperator(EMAIL, fetchImpl as never)).resolves.toBe(false);
  });

  it("passes an abort signal so a hung Resend cannot stall the webhook", async () => {
    process.env.RESEND_API_KEY = "k";
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    await notifyOperator(EMAIL, fetchImpl as never);
    expect(fetchImpl.mock.calls[0][1].signal).toBeDefined();
  });

  it("does not log the Resend response body, which can echo customer emails", async () => {
    process.env.RESEND_API_KEY = "k";
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: false,
      status: 422,
      text: async () => "customer@example.com is invalid",
    });
    await notifyOperator(EMAIL, fetchImpl as never);
    expect(warn.mock.calls.flat().join(" ")).not.toContain("customer@example.com");
  });
});

describe("formatAmount", () => {
  it("renders cents as dollars with the currency", () => {
    expect(formatAmount(2000, "aud")).toBe("$20.00 AUD");
    expect(formatAmount(400, "usd")).toBe("$4.00 USD");
  });

  it("defaults the currency when Stripe omits it", () => {
    expect(formatAmount(2000, null)).toBe("$20.00 AUD");
  });

  it("degrades rather than printing NaN", () => {
    // Stripe can send null amounts; "$NaN" in an operator alert is worse than
    // an honest "unknown".
    expect(formatAmount(null, "aud")).toBe("unknown amount");
    expect(formatAmount(undefined, "aud")).toBe("unknown amount");
  });

  it("handles zero without falling back", () => {
    expect(formatAmount(0, "aud")).toBe("$0.00 AUD");
  });
});
