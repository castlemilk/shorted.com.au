/**
 * @jest-environment node
 */
import {
  settingsLinkKey,
  settingsPageUrl,
  signSettingsGrant,
  verifySettingsToken,
  type SettingsGrant,
} from "../settings-link";

const NOW = 1_800_000_000;
const grant: SettingsGrant = {
  scope: { kind: "guild", id: "1290000000000000001" },
  by: "1290000000000000002",
  expiresAt: NOW + 60,
};

describe("settings link", () => {
  const env = process.env;
  beforeEach(() => {
    process.env = { ...env, NEXTAUTH_SECRET: "test-secret" };
    delete process.env.AUTH_SECRET;
  });
  afterAll(() => {
    process.env = env;
  });

  it("round-trips a grant", () => {
    const key = settingsLinkKey()!;
    const token = signSettingsGrant(grant, key);
    expect(verifySettingsToken(token, key, NOW)).toEqual(grant);
    expect(settingsPageUrl(token)).toMatch(
      /^https:\/\/shorted\.com\.au\/discord\/settings\/open\?t=v1\./,
    );
  });

  it("refuses a token past its expiry", () => {
    const key = settingsLinkKey()!;
    const token = signSettingsGrant(grant, key);
    expect(verifySettingsToken(token, key, NOW + 61)).toBeNull();
  });

  it("refuses a token whose body was changed, even re-encoded", () => {
    const key = settingsLinkKey()!;
    const [v, , sig] = signSettingsGrant(grant, key).split(".");
    const forged = Buffer.from(
      JSON.stringify({
        s: "guild",
        i: "1290000000000000999",
        b: grant.by,
        e: grant.expiresAt,
      }),
    ).toString("base64url");
    expect(verifySettingsToken(`${v}.${forged}.${sig}`, key, NOW)).toBeNull();
  });

  it("refuses a token signed with another key", () => {
    const key = settingsLinkKey()!;
    process.env.NEXTAUTH_SECRET = "another-secret";
    const other = settingsLinkKey()!;
    expect(
      verifySettingsToken(signSettingsGrant(grant, other), key, NOW),
    ).toBeNull();
  });

  it("refuses junk", () => {
    const key = settingsLinkKey()!;
    for (const token of [null, "", "v1", "v2.a.b", "v1..", "x".repeat(600)]) {
      expect(verifySettingsToken(token, key, NOW)).toBeNull();
    }
  });

  it("has no key without a secret", () => {
    delete process.env.NEXTAUTH_SECRET;
    expect(settingsLinkKey()).toBeNull();
  });
});
