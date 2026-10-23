/** @jest-environment node */
import type { NextRequest } from "next/server";

import { bearerMatches, isAuthorizedProbeRequest } from "../auth";

const URL_UNDER_TEST = "https://shorted.com.au/api/internal/paid-probe";

// The jest setup replaces Request with a stub whose headers are a Map, so a
// real NextRequest cannot carry headers here. Only .headers is read, so a
// plain object with the stub Headers is enough (admin-check does the same).
function request(headers: Record<string, string> = {}): NextRequest {
  return { url: URL_UNDER_TEST, method: "POST", headers: new Headers(headers) } as unknown as NextRequest;
}

describe("isAuthorizedProbeRequest", () => {
  const originalSecret = process.env.INTERNAL_SERVICE_SECRET;

  beforeEach(() => {
    process.env.INTERNAL_SERVICE_SECRET = "internal-secret";
  });

  afterAll(() => {
    if (originalSecret === undefined) delete process.env.INTERNAL_SERVICE_SECRET;
    else process.env.INTERNAL_SERVICE_SECRET = originalSecret;
  });

  it("refuses a request with no credential at all", () => {
    expect(isAuthorizedProbeRequest(request(), { PAID_PROBE_TOKEN: "probe-token" })).toBe(false);
  });

  it("refuses a wrong Bearer token", () => {
    expect(
      isAuthorizedProbeRequest(request({ authorization: "Bearer nope" }), { PAID_PROBE_TOKEN: "probe-token" }),
    ).toBe(false);
  });

  it("accepts the correct PAID_PROBE_TOKEN as a Bearer token", () => {
    expect(
      isAuthorizedProbeRequest(request({ authorization: "Bearer probe-token" }), { PAID_PROBE_TOKEN: "probe-token" }),
    ).toBe(true);
  });

  it("accepts the internal service secret as x-internal-secret", () => {
    expect(isAuthorizedProbeRequest(request({ "x-internal-secret": "internal-secret" }), {})).toBe(true);
  });

  it("accepts the internal service secret as a Bearer token", () => {
    expect(isAuthorizedProbeRequest(request({ authorization: "Bearer internal-secret" }), {})).toBe(true);
  });

  it("fails closed when the internal secret is not configured", () => {
    delete process.env.INTERNAL_SERVICE_SECRET;
    expect(isAuthorizedProbeRequest(request({ "x-internal-secret": "" }), {})).toBe(false);
    expect(isAuthorizedProbeRequest(request({ authorization: "Bearer " }), {})).toBe(false);
  });
});

describe("bearerMatches", () => {
  it("never matches when PAID_PROBE_TOKEN is unset, empty or blank", () => {
    for (const expected of [undefined, "", "   "]) {
      expect(bearerMatches(request({ authorization: "Bearer " }), expected)).toBe(false);
      expect(bearerMatches(request({ authorization: "Bearer anything" }), expected)).toBe(false);
    }
  });

  it("never matches a blank presented token against a configured one", () => {
    expect(bearerMatches(request({ authorization: "Bearer " }), "probe-token")).toBe(false);
    expect(bearerMatches(request({ authorization: "Bearer    " }), "probe-token")).toBe(false);
  });

  it("ignores a non-Bearer scheme", () => {
    expect(bearerMatches(request({ authorization: "Basic probe-token" }), "probe-token")).toBe(false);
  });

  it("tolerates a trailing newline on the configured secret", () => {
    expect(bearerMatches(request({ authorization: "Bearer probe-token" }), "probe-token\n")).toBe(true);
  });
});
