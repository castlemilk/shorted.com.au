/**
 * @jest-environment node
 */
import { generateKeyPairSync, sign } from "node:crypto";
import { NextRequest } from "next/server";
import { GET, POST } from "../route";

// The bot's reads are the server actions; nothing here should reach them.
jest.mock("~/@/lib/discord/data", () => ({
  discordData: {
    stockSummary: jest.fn(async () => null),
    search: jest.fn(async () => []),
    topShorts: jest.fn(async () => []),
  },
}));

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const PUBLIC_KEY = Buffer.from(
  publicKey.export({ format: "jwk" }).x!,
  "base64url",
).toString("hex");

/**
 * A POST as Discord sends it. The headers are set after construction: the
 * test setup's Request polyfill (src/test/setup.ts) drops `init.headers`.
 */
function request(
  body: string,
  { signed = true, timestamp = "1760000000", signedBody = body } = {},
) {
  const req = new NextRequest(
    "https://shorted.com.au/api/discord/interactions",
    {
      method: "POST",
      body,
    },
  );
  req.headers.set("content-type", "application/json");
  if (signed) {
    req.headers.set("x-signature-timestamp", timestamp);
    req.headers.set(
      "x-signature-ed25519",
      sign(null, Buffer.from(timestamp + signedBody), privateKey).toString(
        "hex",
      ),
    );
  }
  return req;
}

const PING = JSON.stringify({
  id: "1",
  application_id: "a",
  token: "t",
  type: 1,
});

describe("POST /api/discord/interactions", () => {
  const env = process.env;

  beforeEach(() => {
    process.env = { ...env, DISCORD_PUBLIC_KEY: PUBLIC_KEY };
    jest.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    process.env = env;
    jest.restoreAllMocks();
  });

  it("reports, on GET, which key this deployment verifies with", async () => {
    const response = GET();
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      service: "shorted-discord",
      configured: true,
      publicKey: PUBLIC_KEY,
      activity: false,
    });

    delete process.env.DISCORD_PUBLIC_KEY;
    expect(await GET().json()).toMatchObject({
      configured: false,
      publicKey: null,
    });
  });

  it("answers Discord's PING with a PONG", async () => {
    const response = await POST(request(PING));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ type: 1 });
  });

  it("answers 401 to an unsigned request, as Discord checks before accepting the URL", async () => {
    expect((await POST(request(PING, { signed: false }))).status).toBe(401);
  });

  it("answers 401 to a body altered after signing", async () => {
    const altered = request(PING.replace('"type":1', '"type":2'), {
      signedBody: PING,
    });
    expect((await POST(altered)).status).toBe(401);
  });

  it("is unavailable, not open, without a public key", async () => {
    delete process.env.DISCORD_PUBLIC_KEY;
    expect((await POST(request(PING))).status).toBe(503);
  });

  it("reads a key stored with a stray escaped newline", async () => {
    process.env.DISCORD_PUBLIC_KEY = `${PUBLIC_KEY}\\n`;
    expect((await POST(request(PING))).status).toBe(200);
  });

  it("answers 400 to a signed body that is not JSON", async () => {
    expect((await POST(request("not json"))).status).toBe(400);
  });

  it("routes a signed command and logs a product event", async () => {
    const log = jest.spyOn(console, "log").mockImplementation(() => undefined);
    const body = JSON.stringify({
      id: "2",
      application_id: "a",
      token: "t",
      type: 2,
      data: { name: "help" },
    });
    const response = await POST(request(body));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const json = (await response.json()) as {
      type: number;
      data: { flags: number };
    };
    expect(json.type).toBe(4);
    expect(json.data.flags).toBe(64);
    const events = log.mock.calls
      .map(([line]) => (typeof line === "string" ? line : ""))
      .filter((line) => line.includes('"product_event"'));
    expect(
      events.map((e) => JSON.parse(e) as Record<string, unknown>),
    ).toContainEqual(
      expect.objectContaining({
        feature: "discord",
        action: "command_help",
        status: "success",
        event_type: "immediate",
      }),
    );
  });
});
