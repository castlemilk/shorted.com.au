import {
  APP_DESCRIPTION,
  APP_TAGS,
  DEFAULT_ENDPOINT,
  applicationPatch,
  commandsInSync,
  configAction,
  credentialKind,
  endpointVerdict,
  installLinks,
  parseEndpointStatus,
  portalSteps,
  slashCommands,
  type DiscordApplication,
} from "../setup";

const KEY = "ab".repeat(32);

const fresh: DiscordApplication = {
  id: "1291234567890123456",
  name: "Shorted",
  verify_key: KEY,
  icon: null,
  description: "",
  tags: [],
  interactions_endpoint_url: null,
  integration_types_config: { "0": {} },
};

const empty = { applicationId: "", publicKey: "", activity: false };

describe("configAction", () => {
  it("records a new app in an empty config, keeping the Activity switch", () => {
    expect(configAction(fresh, { ...empty, activity: true })).toEqual({
      kind: "write",
      config: { applicationId: fresh.id, publicKey: KEY, activity: true },
    });
  });

  it("leaves a config that already records the app", () => {
    expect(
      configAction(fresh, {
        applicationId: fresh.id,
        publicKey: KEY.toUpperCase(),
        activity: false,
      }),
    ).toEqual({ kind: "current" });
  });

  it("flags a config that records a different app, rather than replacing it", () => {
    expect(
      configAction(fresh, {
        applicationId: "999",
        publicKey: "cd".repeat(32),
        activity: false,
      }).kind,
    ).toBe("other-app");
  });
});

describe("endpointVerdict", () => {
  const live = (publicKey: string | null) =>
    parseEndpointStatus({
      service: "shorted-discord",
      configured: !!publicKey,
      publicKey,
      activity: false,
    });

  it("is ready when the deployment verifies with this app's key", () => {
    expect(endpointVerdict(live(KEY.toUpperCase()), fresh)).toBe("ready");
  });

  it("tells a deployment without the config from one with another app's", () => {
    expect(endpointVerdict(live(null), fresh)).toBe("unconfigured");
    expect(endpointVerdict(live("cd".repeat(32)), fresh)).toBe("other-key");
  });

  it("is unreachable when the answer is not the bot's", () => {
    expect(parseEndpointStatus({ error: "nope" })).toBeNull();
    expect(parseEndpointStatus("<html>Just a moment...</html>")).toBeNull();
    expect(endpointVerdict(null, fresh)).toBe("unreachable");
  });
});

describe("applicationPatch", () => {
  it("sets everything a fresh app lacks", () => {
    expect(
      applicationPatch(fresh, {
        endpointUrl: DEFAULT_ENDPOINT,
        icon: "data:image/png;base64,AA",
      }),
    ).toEqual({
      interactions_endpoint_url:
        "https://shorted.com.au/api/discord/interactions",
      integration_types_config: {
        "0": {
          oauth2_install_params: {
            scopes: ["applications.commands"],
            permissions: "0",
          },
        },
        "1": {
          oauth2_install_params: {
            scopes: ["applications.commands"],
            permissions: "0",
          },
        },
      },
      description: APP_DESCRIPTION,
      tags: APP_TAGS,
      icon: "data:image/png;base64,AA",
    });
  });

  it("changes nothing on an app already set up, and keeps what was set in the portal", () => {
    const done: DiscordApplication = {
      ...fresh,
      icon: "abc123",
      description: "Our own words",
      tags: ["mine"],
      interactions_endpoint_url: DEFAULT_ENDPOINT,
      integration_types_config: {
        "0": {
          oauth2_install_params: {
            scopes: ["applications.commands", "bot"],
            permissions: "2048",
          },
        },
        "1": {
          oauth2_install_params: {
            scopes: ["applications.commands"],
            permissions: "0",
          },
        },
      },
    };
    expect(
      applicationPatch(done, { endpointUrl: DEFAULT_ENDPOINT, icon: "data:x" }),
    ).toEqual({});
  });

  it("meets Discord's limits on the description and tags", () => {
    expect(APP_DESCRIPTION.length).toBeLessThanOrEqual(400);
    expect(APP_TAGS.length).toBeLessThanOrEqual(5);
    for (const tag of APP_TAGS) expect(tag.length).toBeLessThanOrEqual(20);
  });
});

describe("registered commands", () => {
  const registered = [
    { name: "stock", type: 1 },
    { name: "chart" },
    { name: "search", type: 1 },
    { name: "top", type: 1 },
    { name: "settings", type: 1 },
    { name: "help", type: 1 },
    { name: "launch", type: 4 },
  ];

  it("lists only the slash commands, not the Activity's entry point", () => {
    expect(slashCommands(registered)).toEqual([
      "/stock",
      "/chart",
      "/search",
      "/top",
      "/settings",
      "/help",
    ]);
  });

  it("are in sync when they are exactly this repo's", () => {
    expect(commandsInSync(registered)).toBe(true);
    expect(commandsInSync(registered.slice(1))).toBe(false);
    expect(commandsInSync([...registered, { name: "movers", type: 1 }])).toBe(
      false,
    );
  });
});

it("installLinks asks for commands only, to a server or to a user's apps", () => {
  expect(installLinks("123")).toEqual({
    server:
      "https://discord.com/oauth2/authorize?client_id=123&integration_type=0&scope=applications.commands",
    user: "https://discord.com/oauth2/authorize?client_id=123&integration_type=1&scope=applications.commands",
  });
});

describe("credentialKind", () => {
  it("tells a bot token from the client secret the portal shows beside it", () => {
    // Shapes only: a bot token's first part is the application id, base64.
    const botToken = `${Buffer.from("1291234567890123456").toString("base64url")}.GxYz12.${"a".repeat(38)}`;
    expect(credentialKind(botToken)).toBe("bot-token");
    expect(credentialKind(` ${"Ab3_-x".repeat(5)}Zz `)).toBe("client-secret");
    expect(credentialKind(KEY)).toBe("unknown");
    expect(credentialKind("")).toBe("unknown");
  });
});

describe("portalSteps", () => {
  it("names the endpoint URL and the commands-only install, always", () => {
    const steps = portalSteps(
      { description: "Set already", icon: "abc", tags: ["asx"] },
      DEFAULT_ENDPOINT,
    );
    expect(steps).toEqual([
      `General Information > Interactions Endpoint URL: ${DEFAULT_ENDPOINT}`,
      "Installation > Installation Contexts: User Install and Guild Install",
      "Installation > Default Install Settings: scope applications.commands for both, no permissions",
    ]);
  });

  it("adds the description, tags and icon only where the app has none", () => {
    const steps = portalSteps(
      { description: "", icon: null, tags: [] },
      DEFAULT_ENDPOINT,
    );
    expect(steps).toHaveLength(6);
    expect(steps[3]).toContain(APP_DESCRIPTION);
    expect(steps[4]).toContain(APP_TAGS.join(", "));
    expect(steps[5]).toContain("icon-512.png");
  });
});
