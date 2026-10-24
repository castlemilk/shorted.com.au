import type { NextRequest } from "next/server";

const mockPauseAlertByToken = jest.fn();
jest.mock("~/app/actions/alert-unsubscribe", () => ({
  pauseAlertByToken: (token: string) => mockPauseAlertByToken(token),
}));

import { POST } from "../route";

function request(url: string): NextRequest {
  return { nextUrl: new URL(url) } as unknown as NextRequest;
}

describe("POST /api/alerts/unsubscribe (RFC 8058 one-click)", () => {
  beforeEach(() => {
    mockPauseAlertByToken.mockReset();
    mockPauseAlertByToken.mockResolvedValue({
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
  });

  it("pauses the monitor named by the token and answers a bare 200", async () => {
    const res = await POST(
      request("https://shorted.com.au/api/alerts/unsubscribe?t=signed-token"),
    );

    expect(mockPauseAlertByToken).toHaveBeenCalledWith("signed-token");
    expect(res.status).toBe(200);
    expect(res.body).toBeNull();
    expect(res.headers.get("location")).toBeNull();
  });

  it("answers 200 without calling the action when the token is missing", async () => {
    const res = await POST(
      request("https://shorted.com.au/api/alerts/unsubscribe"),
    );

    expect(mockPauseAlertByToken).not.toHaveBeenCalled();
    expect(res.status).toBe(200);
    expect(res.body).toBeNull();
    expect(res.headers.get("location")).toBeNull();
  });

  it("still answers 200 when the action throws", async () => {
    mockPauseAlertByToken.mockRejectedValueOnce(new Error("backend down"));

    const res = await POST(
      request("https://shorted.com.au/api/alerts/unsubscribe?t=signed-token"),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
  });

  it("still answers 200 when the token is rejected", async () => {
    mockPauseAlertByToken.mockResolvedValueOnce({
      ok: false,
      reason: "invalid",
    });

    const res = await POST(
      request("https://shorted.com.au/api/alerts/unsubscribe?t=forged"),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
  });
});
