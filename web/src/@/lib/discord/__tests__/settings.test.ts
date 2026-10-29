import type { Interaction } from "../api";
import {
  BUILT_IN_SETTINGS,
  actingUserId,
  canManageGuild,
  parseSettings,
  resolveSettings,
  scopeKey,
  settingsScopes,
} from "../settings";

const GUILD = "1290000000000000001";
const USER = "1290000000000000002";

function interaction(fields: Partial<Interaction>): Interaction {
  return { id: "1", application_id: "2", type: 2, token: "t", ...fields };
}

describe("parseSettings", () => {
  it("keeps each valid field and drops each invalid one", () => {
    expect(
      parseSettings({
        code: " bhp ",
        view: "combined",
        period: "6m",
        interactive: true,
        extra: "ignored",
      }),
    ).toEqual({
      code: "BHP",
      view: "combined",
      period: "6m",
      interactive: true,
    });
    expect(
      parseSettings({
        code: "not a code",
        view: "candles",
        period: "2y",
        interactive: "yes",
      }),
    ).toEqual({});
  });

  it("keeps an explicit 'no default stock'", () => {
    expect(parseSettings({ code: null })).toEqual({ code: null });
  });

  it("reads nothing from nothing", () => {
    expect(parseSettings(undefined)).toEqual({});
    expect(parseSettings("guild")).toEqual({});
  });
});

describe("resolveSettings", () => {
  it("takes each field from the first layer that sets it, then the built-ins", () => {
    expect(
      resolveSettings(
        { view: "price" },
        { view: "combined", period: "3m", code: "PLS" },
        null,
      ),
    ).toEqual({
      ...BUILT_IN_SETTINGS,
      view: "price",
      period: "3m",
      code: "PLS",
    });
  });

  it("is the built-ins with nothing set", () => {
    expect(resolveSettings(null, undefined)).toEqual(BUILT_IN_SETTINGS);
  });

  it("lets a server clear the default stock a person set", () => {
    expect(resolveSettings({ code: null }, { code: "PLS" }).code).toBeNull();
  });
});

describe("canManageGuild", () => {
  const inGuild = (permissions?: string) =>
    interaction({
      guild_id: GUILD,
      member: { user: { id: USER }, permissions },
    });

  it("is Manage Server or Administrator, in a server only", () => {
    expect(canManageGuild(inGuild(String(1 << 5)))).toBe(true);
    expect(canManageGuild(inGuild(String(1 << 3)))).toBe(true);
    // Every bit but those two, as a large value only BigInt reads correctly.
    expect(canManageGuild(inGuild("2251799813685207"))).toBe(false);
    expect(canManageGuild(inGuild(undefined))).toBe(false);
    expect(canManageGuild(interaction({ user: { id: USER } }))).toBe(false);
  });
});

describe("scopes", () => {
  it("are the server, then the person, in a server", () => {
    const i = interaction({ guild_id: GUILD, member: { user: { id: USER } } });
    expect(actingUserId(i)).toBe(USER);
    expect(settingsScopes(i).map(scopeKey)).toEqual([
      `guild:${GUILD}`,
      `user:${USER}`,
    ]);
  });

  it("are the person alone in a DM", () => {
    const i = interaction({ user: { id: USER } });
    expect(settingsScopes(i).map(scopeKey)).toEqual([`user:${USER}`]);
  });

  it("ignore ids that are not Discord ids", () => {
    const i = interaction({ guild_id: "../x", user: { id: "admin" } });
    expect(settingsScopes(i)).toEqual([]);
  });
});
