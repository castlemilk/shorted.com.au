/**
 * @jest-environment node
 */
import {
  InteractionResponseType,
  InteractionType,
  MessageFlags,
  type Interaction,
  type InteractionResponse,
  type MessagePayload,
} from "../api";
import { chartCustomId, activityCustomId } from "../custom-id";
import type { DiscordData } from "../data";
import { handleInteraction, type HandlerDeps } from "../handler";
import type { StockHit, StockSummary } from "../messages";
import type { DiscordRest } from "../rest";
import { scopeKey, type DiscordSettings } from "../settings";
import type { SettingsGrant } from "../settings-link";
import type { SettingsStore } from "../settings-store";

// The global setup stubs this module down to `cn`; the figures need the real
// formatNumber.
jest.mock("@/lib/utils", () => jest.requireActual("@/lib/utils"));

const NOW = new Date("2026-10-19T02:00:00Z");

const STOCKS: Record<string, StockSummary> = {
  BHP: { code: "BHP", name: "BHP Group", shortPct: 0.81, change30d: 0.12 },
  PLS: { code: "PLS", name: "Pilbara Minerals", shortPct: 12.3 },
};

const HITS: StockHit[] = [
  { code: "PLS", name: "Pilbara Minerals", shortPct: 12.3 },
  { code: "LTR", name: "Liontown Resources", shortPct: 8.1 },
];

function fakeData(over: Partial<DiscordData> = {}): jest.Mocked<DiscordData> {
  return {
    stockSummary: jest.fn(async (code: string) => STOCKS[code] ?? null),
    search: jest.fn(async (query: string) =>
      query.toLowerCase().startsWith("pil") || query.toLowerCase() === "lith"
        ? HITS
        : [],
    ),
    topShorts: jest.fn(async (count: number) => HITS.slice(0, count)),
    ...over,
  } as jest.Mocked<DiscordData>;
}

function fakeRest(): jest.Mocked<DiscordRest> {
  return {
    editOriginal: jest.fn(async () => undefined),
    deleteOriginal: jest.fn(async () => undefined),
    followUp: jest.fn(async () => undefined),
  };
}

interface Setup {
  data?: jest.Mocked<DiscordData>;
  activityEnabled?: boolean;
  fastPathMs?: number;
  /** Stored settings by scope key ("guild:<id>", "user:<id>"). */
  settings?: Record<string, Partial<DiscordSettings>>;
  /** How long a settings read takes. */
  settingsDelayMs?: number;
  /** Whether settings links can be signed. */
  canSign?: boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function setup({
  data = fakeData(),
  activityEnabled = false,
  fastPathMs = 200,
  settings = {},
  settingsDelayMs = 0,
  canSign = true,
}: Setup = {}) {
  const rest = fakeRest();
  const background: Promise<unknown>[] = [];
  const outcomes: unknown[] = [];
  const settingsStore: jest.Mocked<SettingsStore> = {
    get: jest.fn(async (scope) => {
      if (settingsDelayMs) await sleep(settingsDelayMs);
      return settings[scopeKey(scope)] ?? null;
    }),
    put: jest.fn(async () => undefined),
  };
  const launches: [string, unknown][] = [];
  const grants: SettingsGrant[] = [];
  const deps: HandlerDeps = {
    data,
    rest,
    activityEnabled,
    now: () => NOW,
    waitUntil: (p) => {
      background.push(p);
    },
    fastPathMs,
    onOutcome: (o) => outcomes.push(o),
    settingsStore,
    rememberLaunch: async (channelId, state) => {
      launches.push([channelId, state]);
    },
    settingsUrl: (grant) => {
      grants.push(grant);
      return canSign
        ? `https://shorted.com.au/discord/settings?t=signed`
        : null;
    },
  };
  return {
    data,
    rest,
    outcomes,
    settingsStore,
    launches,
    grants,
    handle: (interaction: Interaction) => handleInteraction(interaction, deps),
    settle: () => Promise.all(background),
  };
}

const base = { id: "1", application_id: "app-1", token: "tok-1" };

function command(
  name: string,
  options: Record<string, string | number> = {},
): Interaction {
  return {
    ...base,
    type: InteractionType.APPLICATION_COMMAND,
    data: {
      name,
      options: Object.entries(options).map(([n, value]) => ({
        name: n,
        type: typeof value === "number" ? 4 : 3,
        value,
      })),
    },
  };
}

function component(custom_id: string, values?: string[]): Interaction {
  return {
    ...base,
    type: InteractionType.MESSAGE_COMPONENT,
    data: { custom_id, component_type: values ? 3 : 2, values },
  };
}

function messageOf(response: InteractionResponse): MessagePayload {
  if (
    !("data" in response) ||
    !response.data ||
    !("allowed_mentions" in response.data)
  ) {
    throw new Error(`no message in response type ${response.type}`);
  }
  return response.data;
}

const never = () => new Promise<never>(() => undefined);

describe("handleInteraction", () => {
  it("answers Discord's PING", async () => {
    const { handle } = setup();
    expect(await handle({ ...base, type: InteractionType.PING })).toEqual({
      type: InteractionResponseType.PONG,
    });
  });

  describe("/stock and /chart", () => {
    it("replies with the chart when the data is quick", async () => {
      const { handle, data } = setup();
      const response = await handle(command("stock", { code: "bhp" }));
      expect(response.type).toBe(
        InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      );
      const message = messageOf(response);
      expect(message.flags).toBeUndefined();
      expect(message.embeds![0]!.title).toBe("BHP · BHP Group");
      expect(message.embeds![0]!.image!.url).toContain("/chart/BHP/image");
      expect(data.stockSummary).toHaveBeenCalledWith("BHP");
    });

    it("charts the view and period asked for", async () => {
      const { handle } = setup();
      const message = messageOf(
        await handle(
          command("chart", { code: "BHP", view: "combined", period: "6m" }),
        ),
      );
      const url = new URL(message.embeds![0]!.image!.url);
      expect(url.searchParams.get("view")).toBe("combined");
      expect(url.searchParams.get("period")).toBe("6m");
    });

    it("finds a stock by company name", async () => {
      const { handle, data } = setup();
      const message = messageOf(
        await handle(command("stock", { code: "Pilbara" })),
      );
      expect(data.search).toHaveBeenCalledWith("Pilbara", 1);
      expect(message.embeds![0]!.title).toBe("PLS · Pilbara Minerals");
    });

    it("searches a code-shaped word that is not a listed code", async () => {
      const { handle, data } = setup();
      const message = messageOf(
        await handle(command("stock", { code: "PILB" })),
      );
      expect(data.stockSummary).toHaveBeenCalledWith("PILB");
      expect(message.embeds![0]!.title).toBe("PLS · Pilbara Minerals");
    });

    it("tells only the asker when nothing matches", async () => {
      const { handle } = setup();
      const message = messageOf(
        await handle(command("stock", { code: "ZZZZ" })),
      );
      expect(message.flags).toBe(MessageFlags.EPHEMERAL);
      expect(message.content).toContain("ZZZZ");
      expect(message.embeds).toBeUndefined();
    });

    it("defers a slow reply and edits it in when it lands", async () => {
      let release!: (s: StockSummary) => void;
      const data = fakeData({
        stockSummary: jest.fn(
          () => new Promise<StockSummary | null>((r) => (release = r)),
        ),
      });
      const { handle, rest, settle, outcomes } = setup({
        data,
        fastPathMs: 20,
      });

      const response = await handle(command("stock", { code: "BHP" }));
      expect(response).toEqual({
        type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
      });
      expect(rest.editOriginal).not.toHaveBeenCalled();

      release(STOCKS.BHP!);
      await settle();
      expect(rest.editOriginal).toHaveBeenCalledTimes(1);
      const [app, token, edit] = rest.editOriginal.mock.calls[0]!;
      expect([app, token]).toEqual(["app-1", "tok-1"]);
      expect(edit.embeds![0]!.title).toBe("BHP · BHP Group");
      expect(outcomes).toContainEqual({
        action: "command_stock",
        status: "success",
        delivery: "deferred",
      });
    });

    it("replaces a slow public 'thinking' with a private note when nothing matches", async () => {
      let release!: (s: StockSummary | null) => void;
      const data = fakeData({
        stockSummary: jest.fn(
          () => new Promise<StockSummary | null>((r) => (release = r)),
        ),
      });
      const { handle, rest, settle } = setup({ data, fastPathMs: 20 });

      await handle(command("stock", { code: "ZZZZ" }));
      release(null);
      await settle();
      expect(rest.editOriginal).not.toHaveBeenCalled();
      expect(rest.deleteOriginal).toHaveBeenCalledWith("app-1", "tok-1");
      expect(rest.followUp.mock.calls[0]![2].flags).toBe(
        MessageFlags.EPHEMERAL,
      );
    });

    it("answers a failure privately instead of leaving Discord to time out", async () => {
      const data = fakeData({
        stockSummary: jest.fn(async () => Promise.reject(new Error("boom"))),
      });
      const { handle, outcomes } = setup({ data });
      jest.spyOn(console, "error").mockImplementation(() => undefined);
      const message = messageOf(
        await handle(command("stock", { code: "BHP" })),
      );
      expect(message.flags).toBe(MessageFlags.EPHEMERAL);
      expect(outcomes).toContainEqual({
        action: "command_stock",
        status: "error",
        delivery: "immediate",
      });
    });
  });

  describe("chart buttons", () => {
    it("redraw the chart in place", async () => {
      const { handle } = setup();
      const response = await handle(
        component(
          chartCustomId("period", { code: "BHP", view: "price", period: "3m" }),
        ),
      );
      expect(response.type).toBe(InteractionResponseType.UPDATE_MESSAGE);
      const url = new URL(messageOf(response).embeds![0]!.image!.url);
      expect(url.searchParams.get("view")).toBe("price");
      expect(url.searchParams.get("period")).toBe("3m");
    });

    it("leave the chart alone, and tell the presser, when the stock cannot be read", async () => {
      const data = fakeData({ stockSummary: jest.fn(async () => null) });
      const { handle } = setup({ data });
      const response = await handle(
        component(
          chartCustomId("view", { code: "BHP", view: "short", period: "1y" }),
        ),
      );
      expect(response.type).toBe(
        InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      );
      expect(messageOf(response).flags).toBe(MessageFlags.EPHEMERAL);
    });

    it("defer a slow redraw without showing anything, then edit the message", async () => {
      let release!: (s: StockSummary) => void;
      const data = fakeData({
        stockSummary: jest.fn(
          () => new Promise<StockSummary | null>((r) => (release = r)),
        ),
      });
      const { handle, rest, settle } = setup({ data, fastPathMs: 20 });
      const response = await handle(
        component(
          chartCustomId("view", {
            code: "BHP",
            view: "combined",
            period: "1y",
          }),
        ),
      );
      expect(response).toEqual({
        type: InteractionResponseType.DEFERRED_UPDATE_MESSAGE,
      });
      release(STOCKS.BHP!);
      await settle();
      expect(rest.editOriginal).toHaveBeenCalledTimes(1);
      expect(rest.editOriginal.mock.calls[0]![2].flags).toBeUndefined();
    });

    it("post a private note, not an edit, when a slow redraw fails", async () => {
      let release!: (s: StockSummary | null) => void;
      const data = fakeData({
        stockSummary: jest.fn(
          () => new Promise<StockSummary | null>((r) => (release = r)),
        ),
      });
      const { handle, rest, settle } = setup({ data, fastPathMs: 20 });
      await handle(
        component(
          chartCustomId("view", { code: "BHP", view: "short", period: "1y" }),
        ),
      );
      release(null);
      await settle();
      expect(rest.editOriginal).not.toHaveBeenCalled();
      expect(rest.deleteOriginal).not.toHaveBeenCalled();
      expect(rest.followUp.mock.calls[0]![2].flags).toBe(
        MessageFlags.EPHEMERAL,
      );
    });
  });

  describe("the Interactive button", () => {
    const id = activityCustomId({ code: "BHP", view: "short", period: "1y" });

    it("launches the Activity when it is enabled", async () => {
      const { handle } = setup({ activityEnabled: true });
      expect(await handle(component(id))).toEqual({
        type: InteractionResponseType.LAUNCH_ACTIVITY,
      });
    });

    it("explains, privately, when it is not", async () => {
      const { handle } = setup({ activityEnabled: false });
      const message = messageOf(await handle(component(id)));
      expect(message.flags).toBe(MessageFlags.EPHEMERAL);
    });
  });

  it("charts a stock picked from a list as a new message", async () => {
    const { handle } = setup();
    const response = await handle(component("pick", ["PLS"]));
    expect(response.type).toBe(
      InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    );
    expect(messageOf(response).embeds![0]!.title).toBe(
      "PLS · Pilbara Minerals",
    );
  });

  it("answers an unknown control privately", async () => {
    const { handle } = setup();
    const message = messageOf(await handle(component("from-an-old-version")));
    expect(message.flags).toBe(MessageFlags.EPHEMERAL);
  });

  it("/search lists matches", async () => {
    const { handle, data } = setup();
    const message = messageOf(
      await handle(command("search", { query: "lith" })),
    );
    expect(data.search).toHaveBeenCalledWith("lith", 10);
    expect(message.embeds![0]!.description).toContain("PLS");
  });

  it("/top clamps the count to Discord's 25-option menu", async () => {
    const { handle, data } = setup();
    await handle(command("top", { count: 500 }));
    expect(data.topShorts).toHaveBeenLastCalledWith(25);
    await handle(command("top", { count: 1 }));
    expect(data.topShorts).toHaveBeenLastCalledWith(5);
    await handle(command("top"));
    expect(data.topShorts).toHaveBeenLastCalledWith(10);
  });

  it("/help answers at once, privately", async () => {
    const { handle, data } = setup();
    const message = messageOf(await handle(command("help")));
    expect(message.flags).toBe(MessageFlags.EPHEMERAL);
    expect(data.stockSummary).not.toHaveBeenCalled();
  });

  it("answers a command it no longer has", async () => {
    const { handle } = setup();
    expect(messageOf(await handle(command("movers"))).flags).toBe(
      MessageFlags.EPHEMERAL,
    );
  });

  describe("autocomplete", () => {
    function typing(value: string): Interaction {
      return {
        ...base,
        type: InteractionType.APPLICATION_COMMAND_AUTOCOMPLETE,
        data: {
          name: "stock",
          options: [{ name: "code", type: 3, value, focused: true }],
        },
      };
    }

    it("searches as the user types", async () => {
      const { handle } = setup();
      const response = await handle(typing("pil"));
      expect(response).toEqual({
        type: InteractionResponseType.APPLICATION_COMMAND_AUTOCOMPLETE_RESULT,
        data: {
          choices: [
            { name: "PLS · Pilbara Minerals · 12.30% short", value: "PLS" },
            { name: "LTR · Liontown Resources · 8.10% short", value: "LTR" },
          ],
        },
      });
    });

    it("offers the most shorted stocks before anything is typed", async () => {
      const { handle, data } = setup();
      await handle(typing(""));
      expect(data.topShorts).toHaveBeenCalledWith(25);
      expect(data.search).not.toHaveBeenCalled();
    });

    it("keeps a typed code on offer when search has nothing", async () => {
      const { handle } = setup();
      const response = await handle(typing("wbt"));
      expect(response).toEqual({
        type: InteractionResponseType.APPLICATION_COMMAND_AUTOCOMPLETE_RESULT,
        data: { choices: [{ name: "WBT", value: "WBT" }] },
      });
    });

    it("answers in time even when search hangs", async () => {
      const data = fakeData({ search: jest.fn(never) });
      const { handle } = setup({ data, fastPathMs: 20 });
      const response = await handle(typing("cba"));
      expect(response).toEqual({
        type: InteractionResponseType.APPLICATION_COMMAND_AUTOCOMPLETE_RESULT,
        data: { choices: [{ name: "CBA", value: "CBA" }] },
      });
    });
  });
});

const GUILD = "1290000000000000001";
const MEMBER = "1290000000000000002";
const CHANNEL = "1290000000000000003";
const MANAGE_GUILD = String(1 << 5);

/** A command as a server member sends it. */
function inServer(interaction: Interaction, permissions = "0"): Interaction {
  return {
    ...interaction,
    guild_id: GUILD,
    channel_id: CHANNEL,
    member: { user: { id: MEMBER }, permissions },
  };
}

/** A command as someone sends it in a DM with the bot. */
function inDm(interaction: Interaction): Interaction {
  return { ...interaction, channel_id: CHANNEL, user: { id: MEMBER } };
}

function chartUrl(message: MessagePayload): URL {
  return new URL(message.embeds![0]!.image!.url);
}

describe("settings", () => {
  it("start /stock with the server's chart and period", async () => {
    const { handle } = setup({
      settings: { [`guild:${GUILD}`]: { view: "combined", period: "3m" } },
    });
    const url = chartUrl(
      messageOf(await handle(inServer(command("stock", { code: "BHP" })))),
    );
    expect(url.searchParams.get("view")).toBe("combined");
    expect(url.searchParams.get("period")).toBe("3m");
  });

  it("open the default stock when no code is given", async () => {
    const { handle } = setup({
      settings: { [`guild:${GUILD}`]: { code: "PLS" } },
    });
    const message = messageOf(await handle(inServer(command("chart"))));
    expect(message.embeds![0]!.title).toBe("PLS · Pilbara Minerals");
  });

  it("ask for a stock, privately, when none is given or set", async () => {
    const { handle } = setup();
    const message = messageOf(await handle(inServer(command("stock"))));
    expect(message.flags).toBe(MessageFlags.EPHEMERAL);
    expect(message.content).toContain("/settings");
  });

  it("yield to what the command says", async () => {
    const { handle } = setup({
      settings: { [`guild:${GUILD}`]: { view: "combined", period: "3m" } },
    });
    const url = chartUrl(
      messageOf(
        await handle(
          inServer(
            command("chart", { code: "BHP", view: "price", period: "max" }),
          ),
        ),
      ),
    );
    expect(url.searchParams.get("view")).toBe("price");
    expect(url.searchParams.get("period")).toBe("max");
  });

  it("are the server's over the member's in a server, and the member's in a DM", async () => {
    const settings = {
      [`guild:${GUILD}`]: { view: "price" as const },
      [`user:${MEMBER}`]: { view: "combined" as const, period: "6m" as const },
    };
    const { handle } = setup({ settings });
    const server = chartUrl(
      messageOf(await handle(inServer(command("stock", { code: "BHP" })))),
    );
    expect(server.searchParams.get("view")).toBe("price");
    // A field the server leaves unset falls through to the member's.
    expect(server.searchParams.get("period")).toBe("6m");
    const dm = chartUrl(
      messageOf(await handle(inDm(command("stock", { code: "BHP" })))),
    );
    expect(dm.searchParams.get("view")).toBe("combined");
  });

  it("give way to the built-ins when the store is slow", async () => {
    const { handle } = setup({
      fastPathMs: 2000,
      settingsDelayMs: 900,
      settings: { [`guild:${GUILD}`]: { view: "price" } },
    });
    const url = chartUrl(
      messageOf(await handle(inServer(command("stock", { code: "BHP" })))),
    );
    expect(url.searchParams.get("view")).toBeNull(); // the built-in, short
  });

  it("chart a picked stock with the server's chart", async () => {
    const { handle } = setup({
      settings: { [`guild:${GUILD}`]: { view: "combined" } },
    });
    const url = chartUrl(
      messageOf(await handle(inServer(component("pick", ["PLS"])))),
    );
    expect(url.pathname).toBe("/chart/PLS/image");
    expect(url.searchParams.get("view")).toBe("combined");
  });
});

describe("interactive mode", () => {
  const interactive = {
    activityEnabled: true,
    settings: {
      [`guild:${GUILD}`]: {
        interactive: true,
        view: "combined" as const,
        period: "6m" as const,
      },
    },
  };

  it("launches the Activity at the chart, handed over by channel", async () => {
    const { handle, launches } = setup(interactive);
    const response = await handle(
      inServer(command("stock", { code: "pilbara" })),
    );
    expect(response).toEqual({ type: InteractionResponseType.LAUNCH_ACTIVITY });
    expect(launches).toEqual([
      [CHANNEL, { code: "PLS", view: "combined", period: "6m" }],
    ]);
  });

  it("launches from a picked stock too", async () => {
    const { handle, launches } = setup(interactive);
    expect((await handle(inServer(component("pick", ["BHP"])))).type).toBe(
      InteractionResponseType.LAUNCH_ACTIVITY,
    );
    expect(launches[0]![1]).toMatchObject({ code: "BHP" });
  });

  it("answers privately when the stock is not found", async () => {
    const { handle, launches } = setup(interactive);
    const message = messageOf(
      await handle(inServer(command("stock", { code: "nothing" }))),
    );
    expect(message.flags).toBe(MessageFlags.EPHEMERAL);
    expect(launches).toEqual([]);
  });

  it("posts the message when the Activity is off", async () => {
    const { handle } = setup({ ...interactive, activityEnabled: false });
    const response = await handle(inServer(command("stock", { code: "BHP" })));
    expect(response.type).toBe(
      InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    );
  });

  it("posts the message, deferred, when the lookup outlasts Discord's window", async () => {
    const data = fakeData({
      stockSummary: jest.fn(async (code: string) => {
        await sleep(300);
        return STOCKS[code] ?? null;
      }),
    });
    const { handle, launches, rest, settle } = setup({
      ...interactive,
      data,
      fastPathMs: 100,
    });
    const response = await handle(inServer(command("stock", { code: "BHP" })));
    expect(response.type).toBe(
      InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    );
    await settle();
    expect(rest.editOriginal).toHaveBeenCalledTimes(1);
    expect(launches).toEqual([]);
  });
});

describe("/settings", () => {
  it("links a manager to the server's settings, privately", async () => {
    const { handle, grants } = setup({
      settings: { [`guild:${GUILD}`]: { code: "PLS", interactive: true } },
    });
    const message = messageOf(
      await handle(inServer(command("settings"), MANAGE_GUILD)),
    );
    expect(message.flags).toBe(MessageFlags.EPHEMERAL);
    expect(message.embeds![0]!.title).toBe("Settings for this server");
    const fields = message.embeds![0]!.fields!;
    expect(fields.find((f) => f.name === "Default stock")!.value).toBe("PLS");
    expect(fields.find((f) => f.name === "Opens as")!.value).toBe(
      "The interactive chart",
    );
    const button = message.components![0]!.components[0]!;
    expect(button).toMatchObject({ label: "Change settings" });
    expect(grants).toEqual([
      {
        scope: { kind: "guild", id: GUILD },
        by: MEMBER,
        expiresAt: Math.floor(NOW.getTime() / 1000) + 30 * 60,
      },
    ]);
  });

  it("gives a member without Manage Server their own settings", async () => {
    const { handle, grants } = setup();
    const message = messageOf(await handle(inServer(command("settings"))));
    expect(message.embeds![0]!.title).toBe("Your settings");
    expect(grants[0]!.scope).toEqual({ kind: "user", id: MEMBER });
  });

  it("refuses a member the server's settings, and says why", async () => {
    const { handle, grants } = setup();
    const message = messageOf(
      await handle(inServer(command("settings", { for: "server" }))),
    );
    expect(message.content).toContain("Manage Server");
    expect(grants).toEqual([]);
  });

  it("gives a manager their own settings when asked", async () => {
    const { handle, grants } = setup();
    await handle(inServer(command("settings", { for: "me" }), MANAGE_GUILD));
    expect(grants[0]!.scope).toEqual({ kind: "user", id: MEMBER });
  });

  it("is personal in a DM", async () => {
    const { handle, grants } = setup();
    await handle(inDm(command("settings")));
    expect(grants[0]!.scope).toEqual({ kind: "user", id: MEMBER });
    const refused = messageOf(
      await handle(inDm(command("settings", { for: "server" }))),
    );
    expect(refused.content).toContain("no server here");
  });

  it("says so when links cannot be signed", async () => {
    const { handle } = setup({ canSign: false });
    const message = messageOf(
      await handle(inServer(command("settings"), MANAGE_GUILD)),
    );
    expect(message.flags).toBe(MessageFlags.EPHEMERAL);
    expect(message.components).toBeUndefined();
  });

  it("defers privately when the store is slow, then replaces the deferral", async () => {
    const { handle, rest, settle } = setup({
      fastPathMs: 50,
      settingsDelayMs: 200,
    });
    const response = await handle(inServer(command("settings"), MANAGE_GUILD));
    expect(response).toEqual({
      type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
      data: { flags: MessageFlags.EPHEMERAL },
    });
    await settle();
    expect(rest.deleteOriginal).not.toHaveBeenCalled();
    expect(rest.editOriginal).toHaveBeenCalledTimes(1);
  });
});
