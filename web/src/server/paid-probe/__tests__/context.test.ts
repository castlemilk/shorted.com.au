/** @jest-environment node */
import { PAID_PROBE_USER_AGENT } from "../constants";
import {
  buildProbeContext,
  isProductionEnv,
  probeFetch,
  resolveProbeOrigin,
  resolvePublicApiOrigin,
} from "../context";
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

const CALLED_ON = "https://shorted.com.au/api/internal/paid-probe";
const PRODUCTION = { VERCEL_ENV: "production" };

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
    const spy = jest.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    const env = { ...process.env, ...BYPASS_ENV };
    const ctx = buildProbeContext(env, { requestUrl: CALLED_ON, shortsApiUrl: "https://shorts.test" });

    await ctx.fetch("https://api.shorted.com.au/shorts.v1alpha1.ShortedStocksService/GetStock", { method: "POST" });

    const headers = (spy.mock.calls[0]![1] as RequestInit).headers as Headers;
    expect(headers.has("x-shorted-ssr-bypass")).toBe(false);
    expect(headers.has("x-shorted-testing-bypass")).toBe(false);
    expect(headers.get("user-agent")).toBe(PAID_PROBE_USER_AGENT);
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
      { requestUrl: CALLED_ON, shortsApiUrl: "https://shorts.test" },
    );
    expect(ctx.internalSecret).toBe("internal-raw ");
    expect(ctx.secrets).toEqual(["internal-raw ", "nextauth-secret"]);
  });

  it("fails the cookie mint, and only the cookie mint, when NEXTAUTH_SECRET is unset", async () => {
    const ctx = buildProbeContext({}, { requestUrl: CALLED_ON, shortsApiUrl: "https://shorts.test" });
    await expect(ctx.sessionCookie()).rejects.toThrow(ProbeFailure);
    await expect(ctx.sessionCookie()).rejects.toThrow("NEXTAUTH_SECRET is not configured");
  });

  it("mints the cookie with NEXTAUTH_SECRET and the production name", async () => {
    const ctx = buildProbeContext(
      { NEXTAUTH_SECRET: "nextauth-secret", NODE_ENV: "production" },
      { requestUrl: CALLED_ON, shortsApiUrl: "https://shorts.test" },
    );
    await expect(ctx.sessionCookie()).resolves.toEqual({
      name: "__Secure-next-auth.session-token",
      value: "jwe-value",
    });
  });
});

describe("isProductionEnv", () => {
  it("mirrors auth.ts: VERCEL_ENV decides when it is set, NODE_ENV when it is not", () => {
    expect(isProductionEnv({ VERCEL_ENV: "production" })).toBe(true);
    expect(isProductionEnv({ VERCEL_ENV: "preview", NODE_ENV: "production" })).toBe(false);
    expect(isProductionEnv({ NODE_ENV: "production" })).toBe(true);
    expect(isProductionEnv({ NODE_ENV: "test" })).toBe(false);
  });
});

describe("resolveProbeOrigin", () => {
  it("uses PAID_PROBE_BASE_URL's origin, and drops any path or query", () => {
    expect(resolveProbeOrigin(CALLED_ON, { PAID_PROBE_BASE_URL: "https://preview.example.test/some/path?x=1" })).toEqual({
      trusted: true,
      value: "https://preview.example.test",
    });
  });

  it("refuses a configured base URL that does not parse, rather than falling back to the request", () => {
    expect(resolveProbeOrigin(CALLED_ON, { PAID_PROBE_BASE_URL: "not a url" })).toEqual({
      trusted: false,
      reason: "untrusted base URL",
    });
    expect(resolveProbeOrigin(CALLED_ON, { PAID_PROBE_BASE_URL: "ftp://files.example.test" })).toEqual({
      trusted: false,
      reason: "untrusted base URL",
    });
  });

  it("uses the request's own origin outside production, on any https host (preview and test)", () => {
    expect(resolveProbeOrigin("https://feature-branch.example.test/api/internal/paid-probe", {})).toEqual({
      trusted: true,
      value: "https://feature-branch.example.test",
    });
    expect(resolveProbeOrigin("https://preview-abc.example.test/x", { VERCEL_ENV: "preview" })).toMatchObject({
      trusted: true,
    });
  });

  it("trusts a request origin in production only when it is a known app host", () => {
    expect(resolveProbeOrigin("https://shorted.com.au/api/internal/paid-probe", PRODUCTION)).toEqual({
      trusted: true,
      value: "https://shorted.com.au",
    });
    expect(resolveProbeOrigin("https://www.shorted.com.au/x", PRODUCTION)).toMatchObject({ trusted: true });
  });

  it("refuses a Host-derived origin in production that is not on the list", () => {
    for (const requestUrl of [
      "https://evil.example/api/internal/paid-probe",
      "https://shorted.com.au.evil.example/x",
      "https://shorted.com.au:8443/x",
      "http://shorted.com.au/x",
    ]) {
      expect(resolveProbeOrigin(requestUrl, PRODUCTION)).toEqual({ trusted: false, reason: "untrusted base URL" });
    }
  });

  it("adds NEXTAUTH_URL's origin to the production allowlist, and ignores it when it does not parse", () => {
    expect(
      resolveProbeOrigin("https://auth.example.test/x", { ...PRODUCTION, NEXTAUTH_URL: "https://auth.example.test/" }),
    ).toMatchObject({ trusted: true, value: "https://auth.example.test" });
    expect(
      resolveProbeOrigin("https://auth.example.test/x", { ...PRODUCTION, NEXTAUTH_URL: "nonsense" }),
    ).toMatchObject({ trusted: false });
  });

  it("applies the same production rule when only NODE_ENV says production (no VERCEL_ENV)", () => {
    expect(resolveProbeOrigin("https://evil.example/x", { NODE_ENV: "production" })).toMatchObject({ trusted: false });
    expect(resolveProbeOrigin("https://shorted.com.au/x", { NODE_ENV: "production" })).toMatchObject({ trusted: true });
  });

  it("refuses plain http outside development, even when the operator configured it", () => {
    expect(resolveProbeOrigin(CALLED_ON, { PAID_PROBE_BASE_URL: "http://localhost:3020" })).toMatchObject({ trusted: false });
    expect(resolveProbeOrigin("http://localhost:3020/x", {})).toMatchObject({ trusted: false });
    expect(resolveProbeOrigin(CALLED_ON, { PAID_PROBE_BASE_URL: "http://localhost:3020", NODE_ENV: "development" })).toEqual({
      trusted: true,
      value: "http://localhost:3020",
    });
  });

  it("trusts the operator's https base URL in production, as the configured word", () => {
    expect(
      resolveProbeOrigin("https://evil.example/x", { ...PRODUCTION, PAID_PROBE_BASE_URL: "https://shorted.com.au" }),
    ).toEqual({ trusted: true, value: "https://shorted.com.au" });
  });
});

describe("resolvePublicApiOrigin", () => {
  it("defaults to the host paying customers call", () => {
    expect(resolvePublicApiOrigin({})).toEqual({ trusted: true, value: "https://api.shorted.com.au" });
  });

  it("refuses any other host in production, however SHORTED_PUBLIC_API_URL is set", () => {
    expect(resolvePublicApiOrigin({ ...PRODUCTION, SHORTED_PUBLIC_API_URL: "https://staging-api.example.test" })).toEqual({
      trusted: false,
      reason: "untrusted public API URL",
    });
    expect(resolvePublicApiOrigin({ ...PRODUCTION, SHORTED_PUBLIC_API_URL: "https://api.shorted.com.au" })).toMatchObject({
      trusted: true,
    });
  });

  it("allows an override outside production, on https only", () => {
    expect(resolvePublicApiOrigin({ SHORTED_PUBLIC_API_URL: "https://staging-api.example.test/" })).toEqual({
      trusted: true,
      value: "https://staging-api.example.test",
    });
    expect(resolvePublicApiOrigin({ SHORTED_PUBLIC_API_URL: "http://staging-api.example.test" })).toMatchObject({
      trusted: false,
    });
    expect(resolvePublicApiOrigin({ SHORTED_PUBLIC_API_URL: "nonsense" })).toMatchObject({ trusted: false });
  });
});
