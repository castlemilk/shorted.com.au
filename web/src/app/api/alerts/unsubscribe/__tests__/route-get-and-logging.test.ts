import type { NextRequest } from "next/server";

const mockPauseAlertByToken = jest.fn();
jest.mock("~/app/actions/alert-unsubscribe", () => ({
  pauseAlertByToken: (token: string) => mockPauseAlertByToken(token),
}));

import { GET, POST } from "../route";

function request(url: string): NextRequest {
  return { nextUrl: new URL(url) } as unknown as NextRequest;
}

describe("GET /api/alerts/unsubscribe", () => {
  beforeEach(() => {
    mockPauseAlertByToken.mockReset();
  });

  it("redirects to the confirmation page and pauses nothing", async () => {
    const res = await GET(
      request("https://shorted.com.au/api/alerts/unsubscribe?t=signed-token"),
    );

    expect(mockPauseAlertByToken).not.toHaveBeenCalled();
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(
      "https://shorted.com.au/alerts/unsubscribe?t=signed-token",
    );
  });

  it("redirects to the confirmation page without a token when none is given", async () => {
    const res = await GET(
      request("https://shorted.com.au/api/alerts/unsubscribe"),
    );

    expect(mockPauseAlertByToken).not.toHaveBeenCalled();
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(
      "https://shorted.com.au/alerts/unsubscribe",
    );
  });
});

describe("POST logging", () => {
  let warn: jest.SpyInstance;

  beforeEach(() => {
    mockPauseAlertByToken.mockReset();
    warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it("logs a rejected token by reason, and never the token itself", async () => {
    mockPauseAlertByToken.mockResolvedValueOnce({
      ok: false,
      reason: "invalid",
    });

    const res = await POST(
      request("https://shorted.com.au/api/alerts/unsubscribe?t=secret-token-value"),
    );

    expect(res.status).toBe(200);
    expect(warn).toHaveBeenCalledWith("alert one-click pause failed: invalid");
    const logged = warn.mock.calls.map((args) => args.join(" ")).join("\n");
    expect(logged).not.toContain("secret-token-value");
  });

  it("does not log a successful pause as a failure", async () => {
    mockPauseAlertByToken.mockResolvedValueOnce({
      ok: true,
      alreadyPaused: false,
      monitor: {
        scope: "stock",
        target: "BHP",
        condition: "short-interest-above",
        threshold: 5,
        cadence: "Daily",
      },
    });

    const res = await POST(
      request("https://shorted.com.au/api/alerts/unsubscribe?t=signed-token"),
    );

    expect(res.status).toBe(200);
    expect(warn).not.toHaveBeenCalled();
  });
});
