/**
 * @jest-environment node
 */
import {
  settingsLinkKey,
  signSettingsGrant,
} from "~/@/lib/discord/settings-link";

const cookieValue = jest.fn<string | undefined, []>();
const put = jest.fn();
const stockSummary = jest.fn();
const search = jest.fn();

jest.mock("next/headers", () => ({
  cookies: () => ({
    get: () => {
      const value = cookieValue();
      return value === undefined ? undefined : { value };
    },
  }),
}));
jest.mock("~/@/lib/discord/settings-store", () => ({
  firestoreSettingsStore: {
    put: (...args: unknown[]) => put(...args) as unknown,
  },
}));
jest.mock("~/@/lib/discord/data", () => ({
  discordData: {
    stockSummary: (code: string) => stockSummary(code) as unknown,
    search: (q: string, limit: number) => search(q, limit) as unknown,
  },
}));

import {
  previewStock,
  saveDiscordSettings,
  searchDiscordStocks,
} from "../actions";

const GUILD = "1290000000000000001";
const USER = "1290000000000000002";
const env = process.env;

function grantCookie(expiresAt = Math.floor(Date.now() / 1000) + 600) {
  return signSettingsGrant(
    { scope: { kind: "guild", id: GUILD }, by: USER, expiresAt },
    settingsLinkKey()!,
  );
}

const VALID = {
  code: "pls",
  view: "combined",
  period: "6m",
  interactive: true,
};

describe("Discord settings actions", () => {
  beforeEach(() => {
    process.env = { ...env, NEXTAUTH_SECRET: "test-secret" };
    cookieValue.mockReset().mockReturnValue(grantCookie());
    put.mockReset().mockResolvedValue(undefined);
    stockSummary
      .mockReset()
      .mockResolvedValue({ code: "PLS", name: "Pilbara" });
    search.mockReset().mockResolvedValue([{ code: "PLS", name: "Pilbara" }]);
    jest.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterAll(() => {
    process.env = env;
  });

  describe("saveDiscordSettings", () => {
    it("saves the grant's scope, as the person it was made for", async () => {
      const result = await saveDiscordSettings({
        ...VALID,
        // Nothing the browser sends picks whose settings change.
        scope: { kind: "guild", id: "1290000000000000999" },
      });
      expect(result).toEqual({
        ok: true,
        settings: {
          code: "PLS",
          view: "combined",
          period: "6m",
          interactive: true,
        },
      });
      expect(put).toHaveBeenCalledWith(
        { kind: "guild", id: GUILD },
        { code: "PLS", view: "combined", period: "6m", interactive: true },
        USER,
      );
    });

    it("saves no default stock without looking one up", async () => {
      const result = await saveDiscordSettings({ ...VALID, code: null });
      expect(result.ok).toBe(true);
      expect(stockSummary).not.toHaveBeenCalled();
      expect(put.mock.calls[0][1]).toMatchObject({ code: null });
    });

    it.each([
      ["no cookie", undefined],
      ["an expired grant", "expired"],
      ["a forged grant", "v1.e30.AAAA"],
    ])("refuses with %s", async (_label, value) => {
      cookieValue.mockReturnValue(
        value === "expired"
          ? grantCookie(Math.floor(Date.now() / 1000) - 5)
          : value,
      );
      const result = await saveDiscordSettings(VALID);
      expect(result).toMatchObject({ ok: false, expired: true });
      expect(put).not.toHaveBeenCalled();
    });

    it.each([
      ["a missing field", { code: "PLS", view: "short", period: "1y" }],
      ["an unknown view", { ...VALID, view: "candles" }],
      ["a period with no button", { ...VALID, period: "2y" }],
      ["a code that is not one", { ...VALID, code: "not a code" }],
      ["nothing", undefined],
    ])("refuses %s rather than filling it in", async (_label, input) => {
      const result = await saveDiscordSettings(input);
      expect(result.ok).toBe(false);
      expect(put).not.toHaveBeenCalled();
    });

    it("refuses a stock that does not exist", async () => {
      stockSummary.mockResolvedValue(null);
      const result = await saveDiscordSettings({ ...VALID, code: "ZZZ" });
      expect(result).toEqual({
        ok: false,
        error: "Couldn't find ZZZ. Pick a stock from the search.",
      });
      expect(put).not.toHaveBeenCalled();
    });

    it("reports a failed write", async () => {
      put.mockRejectedValue(new Error("unavailable"));
      const result = await saveDiscordSettings(VALID);
      expect(result).toMatchObject({ ok: false });
      expect(result).not.toHaveProperty("expired");
    });
  });

  describe("searchDiscordStocks", () => {
    it("searches with a grant", async () => {
      await expect(searchDiscordStocks("  pilbara ")).resolves.toEqual([
        { code: "PLS", name: "Pilbara" },
      ]);
      expect(search).toHaveBeenCalledWith("pilbara", 8);
    });

    it("answers nothing without one, or for nothing", async () => {
      await expect(searchDiscordStocks("   ")).resolves.toEqual([]);
      await expect(searchDiscordStocks({ q: "x" })).resolves.toEqual([]);
      cookieValue.mockReturnValue(undefined);
      await expect(searchDiscordStocks("pilbara")).resolves.toEqual([]);
      expect(search).not.toHaveBeenCalled();
    });
  });

  describe("previewStock", () => {
    it("sends the as-of date as ISO text", async () => {
      stockSummary.mockResolvedValue({
        code: "PLS",
        asOf: new Date("2026-10-20T00:00:00Z"),
      });
      await expect(previewStock("asx:pls")).resolves.toEqual({
        code: "PLS",
        asOf: "2026-10-20T00:00:00.000Z",
      });
      expect(stockSummary).toHaveBeenCalledWith("PLS");
    });

    it("reads nothing for a bad code or without a grant", async () => {
      await expect(previewStock("../x")).resolves.toBeNull();
      cookieValue.mockReturnValue(undefined);
      await expect(previewStock("PLS")).resolves.toBeNull();
      expect(stockSummary).not.toHaveBeenCalled();
    });
  });
});
