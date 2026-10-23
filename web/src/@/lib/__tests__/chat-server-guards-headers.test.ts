/**
 * The chat proxy forwards the browser's headers to the chat service, except the
 * hop-by-hop and credential headers it strips. Vercel's deployment-protection
 * bypass is a credential too: the paid-feature probe sends it to the deployment,
 * and the deployment must not pass it on to the chat service.
 */
import { buildUpstreamHeaders } from "../chat-server-guards";

const TRUSTED = {
  internalSecret: "internal-value",
  userID: "user-1",
  userEmail: "buyer@example.test",
};

describe("buildUpstreamHeaders", () => {
  it("never forwards Vercel's deployment-protection bypass to the chat service", () => {
    const headers = buildUpstreamHeaders(
      new Headers({
        "x-vercel-protection-bypass": "vercel-bypass-value",
        "x-vercel-set-bypass-cookie": "true",
        "content-type": "application/json",
      }),
      TRUSTED,
    );

    expect(headers.get("x-vercel-protection-bypass")).toBeNull();
    expect(headers.get("x-vercel-set-bypass-cookie")).toBeNull();
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("x-internal-secret")).toBe(TRUSTED.internalSecret);
  });

  it("strips the browser's session cookie and sets the trusted identity", () => {
    const headers = buildUpstreamHeaders(
      new Headers({ cookie: "next-auth.session-token=abc", "x-user-id": "spoofed" }),
      TRUSTED,
    );

    expect(headers.get("cookie")).toBeNull();
    expect(headers.get("x-user-id")).toBe(TRUSTED.userID);
    expect(headers.get("x-user-email")).toBe(TRUSTED.userEmail);
  });
});
