import {
  activityLaunchState,
  activitySignInUrl,
  discordClientIdFromHost,
  discordPlatform,
  inDiscordFrame,
  isDiscordLaunch,
} from "../activity";

const params = (query: string) => new URLSearchParams(query);

describe("activityLaunchState", () => {
  it("opens the chart on the button that launched it", () => {
    expect(
      activityLaunchState(
        params(
          "frame_id=f&instance_id=i&platform=desktop&channel_id=11&guild_id=22&custom_id=activity:PLS:combined:6m",
        ),
      ),
    ).toEqual({
      state: { code: "PLS", view: "combined", period: "6m" },
      source: "button",
      channelId: "11",
      guildId: "22",
    });
  });

  it("reads ?code=&view=&period= when opened outside Discord", () => {
    expect(
      activityLaunchState(params("code=wbt&view=price&period=3m")),
    ).toEqual({
      state: { code: "WBT", view: "price", period: "3m" },
      source: "query",
      channelId: null,
      guildId: null,
    });
  });

  it("says nothing chose the chart from the App Launcher or a command", () => {
    expect(
      activityLaunchState(
        params("frame_id=f&instance_id=i&platform=mobile&channel_id=11"),
      ),
    ).toEqual({
      state: { code: "BHP", view: "short", period: "1y" },
      source: "default",
      channelId: "11",
      guildId: null,
    });
  });

  it("ignores a custom_id that is not a chart", () => {
    const launch = activityLaunchState(params("custom_id=pick&code=CBA"));
    expect(launch.state.code).toBe("CBA");
    expect(launch.source).toBe("query");
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

describe("discordPlatform", () => {
  it("reads the platform Discord launched the Activity on", () => {
    expect(
      discordPlatform(params("frame_id=f&instance_id=i&platform=mobile")),
    ).toBe("mobile");
    expect(
      discordPlatform(params("frame_id=f&instance_id=i&platform=desktop")),
    ).toBe("desktop");
  });

  it("is null when the platform is missing or not one Discord sends", () => {
    expect(discordPlatform(params("frame_id=f&instance_id=i"))).toBeNull();
    expect(
      discordPlatform(params("frame_id=f&instance_id=i&platform=x")),
    ).toBeNull();
  });

  it("is null outside a Discord launch, whatever the platform says", () => {
    expect(discordPlatform(params("platform=mobile"))).toBeNull();
    expect(discordPlatform(params("code=CBA&platform=mobile"))).toBeNull();
  });
});

describe("inDiscordFrame", () => {
  it("is true on Discord's proxy host", () => {
    expect(
      inDiscordFrame({
        hostname: "1291234567890123456.discordsays.com",
        search: "",
      }),
    ).toBe(true);
  });

  it("is true for a page carrying Discord's launch parameters", () => {
    expect(
      inDiscordFrame({
        hostname: "localhost",
        search: "?frame_id=f&instance_id=i",
      }),
    ).toBe(true);
  });

  it("is false for a page opened directly", () => {
    expect(
      inDiscordFrame({ hostname: "shorted.com.au", search: "?code=CBA" }),
    ).toBe(false);
  });
});

describe("activitySignInUrl", () => {
  it("returns to the chart's share page turned sideways", () => {
    expect(
      activitySignInUrl({ code: "CBA", view: "combined", period: "max" }),
    ).toBe(
      "https://shorted.com.au/signin?callbackUrl=%2Fchart%2FCBA%3Fview%3Dcombined%26period%3Dmax%26landscape%3D1",
    );
  });

  it("leaves the share page's defaults out of the callback", () => {
    expect(
      activitySignInUrl({ code: "CBA", view: "short", period: "1y" }),
    ).toBe(
      "https://shorted.com.au/signin?callbackUrl=%2Fchart%2FCBA%3Flandscape%3D1",
    );
  });
});
