import {
  activityLaunchState,
  discordClientIdFromHost,
  isDiscordLaunch,
} from "../activity";

const params = (query: string) => new URLSearchParams(query);

describe("activityLaunchState", () => {
  it("opens the chart on the button that launched it", () => {
    expect(
      activityLaunchState(
        params(
          "frame_id=f&instance_id=i&platform=desktop&custom_id=activity:PLS:combined:6m",
        ),
      ),
    ).toEqual({ code: "PLS", view: "combined", period: "6m" });
  });

  it("reads ?code=&view=&period= when opened outside Discord", () => {
    expect(
      activityLaunchState(params("code=wbt&view=price&period=3m")),
    ).toEqual({
      code: "WBT",
      view: "price",
      period: "3m",
    });
  });

  it("falls back to the embed's default chart from the App Launcher", () => {
    expect(
      activityLaunchState(params("frame_id=f&instance_id=i&platform=mobile")),
    ).toEqual({
      code: "BHP",
      view: "short",
      period: "1y",
    });
  });

  it("ignores a custom_id that is not a chart", () => {
    expect(activityLaunchState(params("custom_id=pick&code=CBA")).code).toBe(
      "CBA",
    );
  });
});

describe("isDiscordLaunch", () => {
  it("needs both of Discord's launch parameters", () => {
    expect(isDiscordLaunch(params("frame_id=f&instance_id=i"))).toBe(true);
    expect(isDiscordLaunch(params("frame_id=f"))).toBe(false);
    expect(isDiscordLaunch(params("code=BHP"))).toBe(false);
  });
});

describe("discordClientIdFromHost", () => {
  it("reads the application id from the proxy's hostname", () => {
    expect(discordClientIdFromHost("1291234567890123456.discordsays.com")).toBe(
      "1291234567890123456",
    );
  });

  it.each([
    "shorted.com.au",
    "localhost",
    "evil.discordsays.com.example",
    "abc.discordsays.com",
  ])("is null for %s", (host) => {
    expect(discordClientIdFromHost(host)).toBeNull();
  });
});
