/**
 * @jest-environment node
 */
import { NextRequest } from "next/server";

import {
  SETTINGS_COOKIE,
  settingsLinkKey,
  signSettingsGrant,
} from "~/@/lib/discord/settings-link";
import { GET } from "../route";

const env = process.env;
const nowS = () => Math.floor(Date.now() / 1000);

function open(token: string | null) {
  const url = new URL("https://shorted.com.au/discord/settings/open");
  if (token !== null) url.searchParams.set("t", token);
  return GET(new NextRequest(url));
}

function grantToken(expiresAt: number) {
  return signSettingsGrant(
    {
      scope: { kind: "guild", id: "1290000000000000001" },
      by: "1290000000000000002",
      expiresAt,
    },
    settingsLinkKey()!,
  );
}

describe("GET /discord/settings/open", () => {
  beforeEach(() => {
    process.env = { ...env, NEXTAUTH_SECRET: "test-secret" };
  });
  afterAll(() => {
    process.env = env;
  });

  it("moves a valid token into a cookie on the page and drops it from the URL", () => {
    const token = grantToken(nowS() + 600);
    const res = open(token);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(
      "https://shorted.com.au/discord/settings",
    );
    expect(res.headers.get("cache-control")).toBe("no-store");
    const cookie = res.cookies.get(SETTINGS_COOKIE);
    expect(cookie?.value).toBe(token);
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite).toBe("lax");
    expect(cookie?.path).toBe("/discord/settings");
    // As long as the grant, no longer.
    expect(cookie?.maxAge).toBeGreaterThan(590);
    expect(cookie?.maxAge).toBeLessThanOrEqual(600);
  });

  it.each([
    ["an expired token", () => grantToken(nowS() - 1)],
    ["a forged token", () => `${grantToken(nowS() + 600)}x`],
    ["no token", () => null],
  ])("clears the cookie and says the link expired for %s", (_label, make) => {
    const res = open(make());
    expect(res.headers.get("location")).toBe(
      "https://shorted.com.au/discord/settings?link=expired",
    );
    const cookie = res.cookies.get(SETTINGS_COOKIE);
    expect(cookie?.value).toBe("");
    expect(cookie?.maxAge).toBe(0);
  });

  it("grants nothing on a deployment without a secret", () => {
    const token = grantToken(nowS() + 600);
    delete process.env.NEXTAUTH_SECRET;
    delete process.env.AUTH_SECRET;
    expect(open(token).headers.get("location")).toMatch(/link=expired$/);
  });
});
