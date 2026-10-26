/**
 * @jest-environment node
 */
import { generateKeyPairSync, sign } from "node:crypto";
import { verifyDiscordProxyRequest, verifyDiscordRequest } from "../verify";

function keyPair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" });
  const hex = Buffer.from(jwk.x!, "base64url").toString("hex");
  return { hex, privateKey };
}

const { hex: PUBLIC_KEY, privateKey } = keyPair();

function signed(body: string, timestamp = "1760000000") {
  const signature = sign(
    null,
    Buffer.from(timestamp + body),
    privateKey,
  ).toString("hex");
  return { body, signature, timestamp, publicKey: PUBLIC_KEY };
}

describe("verifyDiscordRequest", () => {
  const body = JSON.stringify({ type: 1 });

  it("accepts a request signed with the application's key", () => {
    expect(verifyDiscordRequest(signed(body))).toBe(true);
  });

  it("accepts the key as the portal shows it, in either case and with whitespace", () => {
    expect(
      verifyDiscordRequest({
        ...signed(body),
        publicKey: ` ${PUBLIC_KEY.toUpperCase()}\n`,
      }),
    ).toBe(true);
  });

  it("rejects a body changed after signing", () => {
    expect(
      verifyDiscordRequest({
        ...signed(body),
        body: JSON.stringify({ type: 2 }),
      }),
    ).toBe(false);
  });

  it("rejects a signature over a different timestamp (a replayed signature)", () => {
    expect(
      verifyDiscordRequest({ ...signed(body), timestamp: "1760000001" }),
    ).toBe(false);
  });

  it("rejects a request signed by another application", () => {
    expect(
      verifyDiscordRequest({ ...signed(body), publicKey: keyPair().hex }),
    ).toBe(false);
  });

  it.each([
    ["no signature", { signature: null }],
    ["no timestamp", { timestamp: null }],
    ["a signature that is not hex", { signature: "z".repeat(128) }],
    ["a truncated signature", { signature: "ab".repeat(10) }],
    // Interactions and proxy payloads share the key and the header names; a
    // timestamp of digits is what keeps the two signed messages apart.
    ["a timestamp that is not digits", { timestamp: "{\"a\":" }],
    ["a timestamp with a sign", { timestamp: "-1760000000" }],
  ])("rejects %s", (_label, over) => {
    expect(verifyDiscordRequest({ ...signed(body), ...over })).toBe(false);
  });

  it("rejects everything when the configured key is malformed, rather than throwing", () => {
    expect(verifyDiscordRequest({ ...signed(body), publicKey: "abcd" })).toBe(
      false,
    );
  });
});

describe("verifyDiscordProxyRequest", () => {
  const NOW = 1_760_000_100;
  const CREATED = 1_760_000_000;
  const fields = {
    user_id: "205519959982473217",
    created_at: CREATED,
    expires_at: CREATED + 300,
  };

  /** Headers as Discord's proxy sends them, signed with the app's key. */
  function proxied(
    data: unknown = fields,
    { encoding = "hex" as "hex" | "base64", timestamp = String(CREATED) } = {},
  ) {
    const bytes = Buffer.from(
      typeof data === "string" ? data : JSON.stringify(data),
      "utf8",
    );
    const signature = sign(null, bytes, privateKey).toString(encoding);
    return {
      payload: bytes.toString("base64"),
      signature,
      timestamp,
      publicKey: PUBLIC_KEY,
      now: NOW,
    };
  }

  it("accepts the headers Discord signed, and returns the payload it signed", () => {
    const result = verifyDiscordProxyRequest(proxied());
    expect(result).toEqual({
      ok: true,
      payload: fields,
      createdAt: CREATED,
      expiresAt: CREATED + 300,
    });
  });

  it("takes the signature in hex or base64: Discord's samples use both", () => {
    expect(
      verifyDiscordProxyRequest(proxied(fields, { encoding: "base64" })).ok,
    ).toBe(true);
  });

  it("calls a request with none of the headers missing, not malformed", () => {
    expect(
      verifyDiscordProxyRequest({
        payload: null,
        signature: null,
        timestamp: null,
        publicKey: PUBLIC_KEY,
        now: NOW,
      }),
    ).toEqual({ ok: false, reason: "missing" });
  });

  it.each([
    ["no payload", { payload: null }],
    ["no signature", { signature: null }],
    ["no timestamp", { timestamp: null }],
    ["a payload that is not base64", { payload: "not base64!" }],
    ["a payload far past any Discord sends", { payload: "A".repeat(9000) }],
    ["a signature that is not 64 bytes", { signature: "ab".repeat(10) }],
    ["a timestamp that is not digits", { timestamp: "soon" }],
  ])("rejects %s as malformed", (_label, over) => {
    expect(verifyDiscordProxyRequest({ ...proxied(), ...over })).toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  it("rejects a payload changed after signing, even to extend its own expiry", () => {
    const signed = proxied();
    const forged = Buffer.from(
      JSON.stringify({ ...fields, expires_at: CREATED + 86_400 }),
    ).toString("base64");
    expect(verifyDiscordProxyRequest({ ...signed, payload: forged })).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("rejects a payload signed by another application", () => {
    expect(
      verifyDiscordProxyRequest({ ...proxied(), publicKey: keyPair().hex }),
    ).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("checks the times only after the signature: a forged expiry reads as forged", () => {
    const signed = proxied();
    const forged = Buffer.from(
      JSON.stringify({ ...fields, expires_at: 1 }),
    ).toString("base64");
    expect(verifyDiscordProxyRequest({ ...signed, payload: forged }).ok).toBe(
      false,
    );
    expect(
      verifyDiscordProxyRequest({ ...signed, payload: forged }),
    ).toMatchObject({ reason: "bad_signature" });
  });

  it("rejects a timestamp header that is not the payload's created_at", () => {
    expect(
      verifyDiscordProxyRequest(
        proxied(fields, { timestamp: String(CREATED + 1) }),
      ),
    ).toEqual({ ok: false, reason: "timestamp_mismatch" });
  });

  it("rejects an expired payload, and accepts one in its last second", () => {
    expect(
      verifyDiscordProxyRequest({ ...proxied(), now: CREATED + 301 }),
    ).toEqual({ ok: false, reason: "expired" });
    expect(
      verifyDiscordProxyRequest({ ...proxied(), now: CREATED + 300 }).ok,
    ).toBe(true);
  });

  it("rejects a payload from the future, beyond a minute of clock skew", () => {
    expect(
      verifyDiscordProxyRequest({ ...proxied(), now: CREATED - 61 }),
    ).toEqual({ ok: false, reason: "not_yet_valid" });
    expect(
      verifyDiscordProxyRequest({ ...proxied(), now: CREATED - 60 }).ok,
    ).toBe(true);
  });

  it.each([
    ["not JSON", "created_at=1760000000"],
    ["a JSON array", [1, 2]],
    ["no expires_at", { created_at: CREATED }],
    ["times as strings", { created_at: String(CREATED), expires_at: "x" }],
  ])("rejects a signed payload that is %s", (_label, data) => {
    expect(verifyDiscordProxyRequest(proxied(data))).toEqual({
      ok: false,
      reason: "bad_payload",
    });
  });

  it("never lets a proxy signature pass as an interaction, or the reverse", () => {
    // The same key signs both, under the same header names.
    const proxy = proxied();
    const bytes = Buffer.from(proxy.payload, "base64").toString("utf8");
    for (let cut = 0; cut <= bytes.length; cut++) {
      expect(
        verifyDiscordRequest({
          body: bytes.slice(cut),
          signature: proxy.signature,
          timestamp: bytes.slice(0, cut),
          publicKey: PUBLIC_KEY,
        }),
      ).toBe(false);
    }
    const interaction = signed(JSON.stringify({ type: 1 }), String(CREATED));
    expect(
      verifyDiscordProxyRequest({
        payload: Buffer.from(
          interaction.timestamp + interaction.body,
        ).toString("base64"),
        signature: interaction.signature,
        timestamp: interaction.timestamp,
        publicKey: PUBLIC_KEY,
        now: NOW,
      }),
    ).toEqual({ ok: false, reason: "bad_payload" });
  });

  it("never throws, even on a malformed configured key", () => {
    expect(
      verifyDiscordProxyRequest({ ...proxied(), publicKey: "abcd" }),
    ).toEqual({ ok: false, reason: "bad_signature" });
  });
});
