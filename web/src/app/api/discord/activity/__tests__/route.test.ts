/**
 * @jest-environment node
 */
import { generateKeyPairSync, sign } from "node:crypto";
import { NextRequest } from "next/server";
import { POST } from "../route";

// Keys come from the environment here, never from the committed production app.
jest.mock("~/config/discord-app.json", () => ({
  applicationId: "",
  publicKey: "",
  activity: false,
}));

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const PUBLIC_KEY = Buffer.from(
  publicKey.export({ format: "jwk" }).x!,
  "base64url",
).toString("hex");

const NOW_MS = Date.UTC(2026, 9, 23, 5, 0, 0);
const NOW = NOW_MS / 1000;
const USER_ID = "205519959982473217";

/**
 * A POST as Discord's proxy forwards it. The headers are set after
 * construction: the test setup's Request polyfill drops `init.headers`.
 */
function request(headers: Record<string, string> = {}) {
  const req = new NextRequest("https://shorted.com.au/api/discord/activity", {
    method: "POST",
  });
  for (const [name, value] of Object.entries(headers)) {
    req.headers.set(name, value);
  }
  return req;
}

function proxyHeaders(fields: Record<string, unknown> = {}) {
  const payload = Buffer.from(
    JSON.stringify({
      user_id: USER_ID,
      created_at: NOW - 5,
      expires_at: NOW + 300,
      ...fields,
    }),
  );
  return {
    "x-discord-proxy-payload": payload.toString("base64"),
    "x-signature-ed25519": sign(null, payload, privateKey).toString("hex"),
    "x-signature-timestamp": String(fields.created_at ?? NOW - 5),
  };
}

/** The product events and other JSON lines the route logged. */
function logged(log: jest.SpyInstance): Record<string, unknown>[] {
  return log.mock.calls.map(([line]) => JSON.parse(String(line)));
}

describe("POST /api/discord/activity", () => {
  const env = process.env;
  let log: jest.SpyInstance;

  beforeEach(() => {
    process.env = { ...env, DISCORD_PUBLIC_KEY: PUBLIC_KEY };
    jest.useFakeTimers({ now: NOW_MS });
    log = jest.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    process.env = env;
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it("answers 204 to headers Discord signed, and records them verified", () => {
    const response = POST(request(proxyHeaders()));
    expect(response.status).toBe(204);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(logged(log)[0]).toMatchObject({
      type: "product_event",
      feature: "discord",
      action: "activity_proxy_auth",
      status: "success",
      event_type: "verified",
    });
  });

  it("logs the payload's field names, never a value, once per shape", () => {
    POST(request(proxyHeaders({ guild_id: "1" })));
    POST(request(proxyHeaders({ guild_id: "2" })));
    const shapes = logged(log).filter(
      (l) => l.type === "discord_proxy_payload_fields",
    );
    expect(shapes).toEqual([
      {
        type: "discord_proxy_payload_fields",
        fields: ["created_at", "expires_at", "guild_id", "user_id"],
      },
    ]);
    expect(JSON.stringify(log.mock.calls)).not.toContain(USER_ID);
  });

  it("answers 204 to a request without the headers, and records it missing", () => {
    const response = POST(request());
    expect(response.status).toBe(204);
    expect(logged(log)).toEqual([
      expect.objectContaining({
        status: "unauthenticated",
        event_type: "missing",
      }),
    ]);
  });

  it("answers 401 to headers that fail, and records why", () => {
    const headers = proxyHeaders();
    const forged = request({
      ...headers,
      "x-discord-proxy-payload": Buffer.from(
        JSON.stringify({ user_id: "1", created_at: NOW - 5, expires_at: NOW + 300 }),
      ).toString("base64"),
    });
    expect(POST(forged).status).toBe(401);

    const expired = request(
      proxyHeaders({ created_at: NOW - 600, expires_at: NOW - 300 }),
    );
    expect(POST(expired).status).toBe(401);

    expect(logged(log).map((l) => [l.status, l.event_type])).toEqual([
      ["error", "bad_signature"],
      ["error", "expired"],
    ]);
  });

  it("never logs the signed headers themselves", () => {
    const headers = proxyHeaders();
    POST(request(headers));
    const lines = JSON.stringify(log.mock.calls);
    for (const value of Object.values(headers)) {
      expect(lines).not.toContain(value);
    }
  });

  it("answers 503, and records nothing, before the app is configured", () => {
    delete process.env.DISCORD_PUBLIC_KEY;
    expect(POST(request(proxyHeaders())).status).toBe(503);
    expect(log).not.toHaveBeenCalled();
  });
});
