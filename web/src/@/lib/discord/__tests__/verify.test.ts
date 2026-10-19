/**
 * @jest-environment node
 */
import { generateKeyPairSync, sign } from "node:crypto";
import { verifyDiscordRequest } from "../verify";

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
  ])("rejects %s", (_label, over) => {
    expect(verifyDiscordRequest({ ...signed(body), ...over })).toBe(false);
  });

  it("rejects everything when the configured key is malformed, rather than throwing", () => {
    expect(verifyDiscordRequest({ ...signed(body), publicKey: "abcd" })).toBe(
      false,
    );
  });
});
