/** @jest-environment node */
import { PAID_PROBE_USER_AGENT } from "../constants";
import { buildProbeContext, probeFetch, resolveProbeOrigin } from "../context";
import { ProbeFailure } from "../types";

// session-cookie imports next-auth/jwt, which jest cannot parse (see session-cookie.test.ts).
jest.mock("next-auth/jwt", () => ({
  encode: jest.fn(async () => "jwe-value"),
  decode: jest.fn(),
}));

const BYPASS_ENV = {
  SHORTED_SSR_BYPASS_SECRET: "ssr-bypass-value",
  SHORTED_CLOUDFLARE_TESTING_BYPASS_SECRET: "testing-bypass-value",
  TF_VAR_rate_limit_testing_bypass_secret: "testing-bypass-value",
};

describe("probeFetch", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("sends the probe user agent and nothing that marks it as first-party or E2E", async () => {
    const spy = jest.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));

    await probeFetch()("https://api.shorted.com.au/x", {
      headers: { "user-agent": "shorted-web-ssr/1.0", "x-custom": "kept" },
    });

    const headers = (spy.mock.calls[0]![1] as RequestInit).headers as Headers;
    expect(headers.get("user-agent")).toBe(PAID_PROBE_USER_AGENT);
    expect(PAID_PROBE_USER_AGENT).not.toContain("shorted-web-ssr");
    expect(PAID_PROBE_USER_AGENT).not.toContain("Shorted-E2E");
    expect(headers.get("x-custom")).toBe("kept");
    expect((spy.mock.calls[0]![1] as RequestInit).cache).toBe("no-store");
  });

  it("never attaches a bypass secret, even when the environment holds one", async () => {
    Object.assign(process.env, BYPASS_ENV);
    const spy = jest.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    try {
      const ctx = buildProbeContext(
        { ...process.env, ...BYPASS_ENV },
        { origin: "https://shorted.com.au", shortsApiUrl: "https://shorts.test" },
      );
      await ctx.fetch("https://shorts.test/shorts.v1alpha1.ShortedStocksService/GetStock", { method: "POST" });

      const headers = (spy.mock.calls[0]![1] as RequestInit).headers as Headers;
      expect(headers.has("x-shorted-ssr-bypass")).toBe(false);
      expect(headers.has("x-shorted-testing-bypass")).toBe(false);
      expect(headers.get("user-agent")).toBe(PAID_PROBE_USER_AGENT);
    } finally {
      for (const key of Object.keys(BYPASS_ENV)) delete process.env[key];
    }
  });
});

describe("buildProbeContext", () => {
  it("carries the internal secret raw, and scrubs only configured secrets", () => {
    const ctx = buildProbeContext(
      {
        INTERNAL_SERVICE_SECRET: "internal-raw ",
        NEXTAUTH_SECRET: "nextauth-secret",
        PAID_PROBE_TOKEN: "  ",
        UNRELATED: "keep-me",
      },
      { origin: "https://shorted.com.au", shortsApiUrl: "https://shorts.test" },
    );
    expect(ctx.internalSecret).toBe("internal-raw ");
    expect(ctx.secrets).toEqual(["internal-raw ", "nextauth-secret"]);
  });

  it("fails the cookie mint, and only the cookie mint, when NEXTAUTH_SECRET is unset", async () => {
    const ctx = buildProbeContext({}, { origin: "https://shorted.com.au", shortsApiUrl: "https://shorts.test" });
    await expect(ctx.sessionCookie()).rejects.toThrow(ProbeFailure);
    await expect(ctx.sessionCookie()).rejects.toThrow("NEXTAUTH_SECRET is not configured");
  });

  it("mints the cookie with NEXTAUTH_SECRET and the production name", async () => {
    const ctx = buildProbeContext(
      { NEXTAUTH_SECRET: "nextauth-secret", NODE_ENV: "production" },
      { origin: "https://shorted.com.au", shortsApiUrl: "https://shorts.test" },
    );
    await expect(ctx.sessionCookie()).resolves.toEqual({
      name: "__Secure-next-auth.session-token",
      value: "jwe-value",
    });
  });
});

describe("resolveProbeOrigin", () => {
  const CALLED_ON = "https://shorted.com.au/api/internal/paid-probe";

  it("uses PAID_PROBE_BASE_URL's origin when it is a usable http(s) URL", () => {
    expect(resolveProbeOrigin(CALLED_ON, "https://preview.example.test/some/path?x=1")).toBe(
      "https://preview.example.test",
    );
  });

  it("falls back to the origin the probe was called on", () => {
    expect(resolveProbeOrigin(CALLED_ON, undefined)).toBe("https://shorted.com.au");
    expect(resolveProbeOrigin(CALLED_ON, "   ")).toBe("https://shorted.com.au");
    expect(resolveProbeOrigin(CALLED_ON, "ftp://files.example.test")).toBe("https://shorted.com.au");
    expect(resolveProbeOrigin(CALLED_ON, "not a url")).toBe("https://shorted.com.au");
  });
});
