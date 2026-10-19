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
}

function setup({
  data = fakeData(),
  activityEnabled = false,
  fastPathMs = 200,
}: Setup = {}) {
  const rest = fakeRest();
  const background: Promise<unknown>[] = [];
  const outcomes: unknown[] = [];
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
  };
  return {
    data,
    rest,
    outcomes,
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
