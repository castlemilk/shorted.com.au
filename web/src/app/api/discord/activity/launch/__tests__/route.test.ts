/**
 * @jest-environment node
 */
import { NextRequest } from "next/server";

const recallLaunch = jest.fn();
const getSettings = jest.fn();

jest.mock("~/@/lib/discord/launch", () => ({
  recallLaunch: (channel: string) => recallLaunch(channel) as unknown,
}));
jest.mock("~/@/lib/discord/settings-store", () => ({
  firestoreSettingsStore: {
    get: (scope: unknown) => getSettings(scope) as unknown,
  },
}));

import { GET } from "../route";

const CHANNEL = "1290000000000000003";
const GUILD = "1290000000000000001";

function ask(query: string) {
  return GET(
    new NextRequest(
      `https://shorted.com.au/api/discord/activity/launch?${query}`,
    ),
  );
}

describe("GET /api/discord/activity/launch", () => {
  beforeEach(() => {
    recallLaunch.mockReset().mockResolvedValue(null);
    getSettings.mockReset().mockResolvedValue(null);
  });

  it("opens the chart a command just asked for in the channel", async () => {
    recallLaunch.mockResolvedValue({
      code: "PLS",
      view: "combined",
      period: "6m",
    });
    getSettings.mockResolvedValue({ code: "BHP" });
    const res = await ask(`channel=${CHANNEL}&guild=${GUILD}`);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({
      source: "command",
      state: { code: "PLS", view: "combined", period: "6m" },
    });
    expect(recallLaunch).toHaveBeenCalledWith(CHANNEL);
  });

  it("else opens the server's defaults", async () => {
    getSettings.mockResolvedValue({ code: "WBT", view: "price" });
    const res = await ask(`channel=${CHANNEL}&guild=${GUILD}`);
    expect(await res.json()).toEqual({
      source: "server",
      state: { code: "WBT", view: "price", period: "1y" },
    });
    expect(getSettings).toHaveBeenCalledWith({ kind: "guild", id: GUILD });
  });

  it("uses the embed's stock for a server that set a chart but no stock", async () => {
    getSettings.mockResolvedValue({ view: "combined" });
    const res = await ask(`guild=${GUILD}`);
    expect((await res.json()).state).toEqual({
      code: "BHP",
      view: "combined",
      period: "1y",
    });
  });

  it("answers nothing when nothing is set", async () => {
    expect(await (await ask(`guild=${GUILD}`)).json()).toEqual({
      source: "none",
      state: null,
    });
  });

  it("ignores ids that are not Discord's", async () => {
    await ask("channel=../etc&guild=x");
    expect(recallLaunch).not.toHaveBeenCalled();
    expect(getSettings).not.toHaveBeenCalled();
  });
});

describe("GET /api/discord/activity/launch: a recalled chart kept as posted", () => {
  beforeEach(() => {
    recallLaunch.mockReset().mockResolvedValue(null);
    getSettings.mockReset().mockResolvedValue(null);
  });

  it("passes a valid anchor through", async () => {
    recallLaunch.mockResolvedValue({
      code: "WBT",
      view: "combined",
      period: "3m",
      anchor: { day: "2026-11-04", shorts: "2026-10-29", prices: "2026-11-03" },
    });
    expect(await (await ask(`channel=${CHANNEL}`)).json()).toEqual({
      source: "command",
      state: {
        code: "WBT",
        view: "combined",
        period: "3m",
        anchor: { day: "2026-11-04", shorts: "2026-10-29", prices: "2026-11-03" },
      },
    });
  });

  it("drops an anchor whose day is not a real day, leaving a live chart", async () => {
    recallLaunch.mockResolvedValue({
      code: "WBT",
      view: "combined",
      period: "3m",
      anchor: { day: "2026-02-30", shorts: "2026-02-30" },
    });
    const body = await (await ask(`channel=${CHANNEL}`)).json();
    expect(body.state).toEqual({ code: "WBT", view: "combined", period: "3m" });
    expect(body.state).not.toHaveProperty("anchor");
  });

  it("drops an anchor that is not an object", async () => {
    recallLaunch.mockResolvedValue({
      code: "WBT",
      view: "price",
      period: "1y",
      anchor: "2026-11-04",
    });
    const body = await (await ask(`channel=${CHANNEL}`)).json();
    expect(body.state).toEqual({ code: "WBT", view: "price", period: "1y" });
  });

  it("pulls a shorts or prices day after the posting day back to it", async () => {
    recallLaunch.mockResolvedValue({
      code: "WBT",
      view: "short",
      period: "1m",
      anchor: { day: "2026-11-04", shorts: "2026-11-09", prices: "2026-11-09" },
    });
    const body = await (await ask(`channel=${CHANNEL}`)).json();
    expect(body.state.anchor).toEqual({
      day: "2026-11-04",
      shorts: "2026-11-04",
      prices: "2026-11-04",
    });
  });

  it("drops an anchor dated after today (Sydney), leaving a live chart", async () => {
    jest.useFakeTimers({ now: new Date("2026-11-03T23:00:00Z") });
    try {
      recallLaunch.mockResolvedValue({
        code: "WBT",
        view: "combined",
        period: "3m",
        anchor: { day: "2026-11-05", shorts: "2026-11-05", prices: "2026-11-05" },
      });
      const body = await (await ask(`channel=${CHANNEL}`)).json();
      expect(body.state).toEqual({ code: "WBT", view: "combined", period: "3m" });
    } finally {
      jest.useRealTimers();
    }
  });
});

