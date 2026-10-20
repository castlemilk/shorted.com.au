import { siteConfig } from "~/@/config/site";
import { ApplicationIntegrationType } from "./api";
import { COMMAND_NAMES } from "./commands";
import type { DiscordAppConfig } from "./config";

/**
 * The decisions behind `task discord:setup` and `task discord:status`
 * (scripts/discord.ts), kept pure so they are tested here and the script is
 * only input and output.
 */

export const DEFAULT_ENDPOINT = `${siteConfig.url}/api/discord/interactions`;

export const APP_DESCRIPTION =
  "ASX short interest in your chat. Search stocks, post live short-interest and price charts, and flip their period and view in place. Data from ASIC's daily short position reports, via shorted.com.au.";

export const APP_TAGS = ["stocks", "asx", "finance", "charts", "short selling"];

/** The part of Discord's application object the setup reads. */
export interface DiscordApplication {
  id: string;
  name: string;
  /** The public key, hex. */
  verify_key: string;
  icon: string | null;
  description: string;
  tags?: string[];
  interactions_endpoint_url?: string | null;
  integration_types_config?: Record<
    string,
    { oauth2_install_params?: { scopes: string[]; permissions: string } }
  >;
}

/** What GET /api/discord/interactions reports about a deployment. */
export interface EndpointStatus {
  configured: boolean;
  publicKey: string | null;
  activity: boolean;
}

export function parseEndpointStatus(json: unknown): EndpointStatus | null {
  if (!json || typeof json !== "object") return null;
  const r = json as Record<string, unknown>;
  if (r.service !== "shorted-discord") return null;
  return {
    configured: r.configured === true,
    publicKey: typeof r.publicKey === "string" ? r.publicKey : null,
    activity: r.activity === true,
  };
}

export type ConfigAction =
  | { kind: "current" }
  /** The file is empty: record this app, the first time. */
  | { kind: "write"; config: DiscordAppConfig }
  /** The file names another app; replacing it switches production's bot. */
  | { kind: "other-app"; config: DiscordAppConfig };

export function configAction(
  app: DiscordApplication,
  current: DiscordAppConfig,
): ConfigAction {
  const config = {
    applicationId: app.id,
    publicKey: app.verify_key.toLowerCase(),
    activity: current.activity,
  };
  if (
    current.applicationId === config.applicationId &&
    current.publicKey.toLowerCase() === config.publicKey
  ) {
    return { kind: "current" };
  }
  return current.applicationId
    ? { kind: "other-app", config }
    : { kind: "write", config };
}

export type EndpointVerdict =
  /** Deployed with this app's key: Discord's requests will verify. */
  | "ready"
  /** Reachable, but no key yet: the config has not been deployed. */
  | "unconfigured"
  /** Deployed with a different app's key. */
  | "other-key"
  /** No status answer: not deployed yet, or blocked before it. */
  | "unreachable";

export function endpointVerdict(
  status: EndpointStatus | null,
  app: Pick<DiscordApplication, "verify_key">,
): EndpointVerdict {
  if (!status) return "unreachable";
  if (!status.configured || !status.publicKey) return "unconfigured";
  return status.publicKey.toLowerCase() === app.verify_key.toLowerCase()
    ? "ready"
    : "other-key";
}

const INSTALL_PARAMS = {
  oauth2_install_params: {
    scopes: ["applications.commands"],
    permissions: "0",
  },
};

function installsEverywhere(app: DiscordApplication): boolean {
  return [
    ApplicationIntegrationType.GUILD_INSTALL,
    ApplicationIntegrationType.USER_INSTALL,
  ].every((type) =>
    app.integration_types_config?.[
      String(type)
    ]?.oauth2_install_params?.scopes.includes("applications.commands"),
  );
}

/**
 * What to change on the application (PATCH /applications/@me), and nothing
 * else: the endpoint URL, installation to servers and to users' accounts
 * (commands only, no bot permissions), and a description, tags and icon only
 * where the app has none, so whatever was set in the portal is kept.
 */
export function applicationPatch(
  app: DiscordApplication,
  { endpointUrl, icon }: { endpointUrl: string; icon?: string },
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (app.interactions_endpoint_url !== endpointUrl) {
    patch.interactions_endpoint_url = endpointUrl;
  }
  if (!installsEverywhere(app)) {
    patch.integration_types_config = {
      [ApplicationIntegrationType.GUILD_INSTALL]: INSTALL_PARAMS,
      [ApplicationIntegrationType.USER_INSTALL]: INSTALL_PARAMS,
    };
  }
  if (!app.description?.trim()) patch.description = APP_DESCRIPTION;
  if (!app.tags?.length) patch.tags = APP_TAGS;
  if (!app.icon && icon) patch.icon = icon;
  return patch;
}

/**
 * Which credential a value looks like. A bot token is three dot-separated
 * parts (the first is the application id, base64); an OAuth2 client secret is
 * 32 URL-safe characters. The portal shows the client secret on its OAuth2
 * page and the bot token only behind Bot > Reset Token, so the two get
 * swapped.
 */
export function credentialKind(
  value: string,
): "bot-token" | "client-secret" | "unknown" {
  const v = value.trim();
  if (/^[\w-]+\.[\w-]+\.[\w-]+$/.test(v)) return "bot-token";
  if (/^[\w-]{32}$/.test(v)) return "client-secret";
  return "unknown";
}

/**
 * What a client secret cannot set, as portal steps: only a bot token may edit
 * the application (PATCH /applications/@me), so with the client secret alone
 * these are done by hand, once. The optional lines appear only where the app
 * has nothing yet.
 */
export function portalSteps(
  app: Pick<DiscordApplication, "description" | "icon" | "tags">,
  endpointUrl: string,
): string[] {
  const steps = [
    `General Information > Interactions Endpoint URL: ${endpointUrl}`,
    "Installation > Installation Contexts: User Install and Guild Install",
    "Installation > Default Install Settings: scope applications.commands for both, no permissions",
  ];
  if (!app.description?.trim()) {
    steps.push(`General Information > Description: ${APP_DESCRIPTION}`);
  }
  if (!app.tags?.length) {
    steps.push(`General Information > Tags: ${APP_TAGS.join(", ")}`);
  }
  if (!app.icon) {
    steps.push("General Information > App Icon: web/public/icon-512.png");
  }
  return steps;
}

export interface RegisteredCommand {
  name: string;
  /** 1 a slash command; 4 the Activity's Entry Point, which Discord made. */
  type?: number;
}

/** The slash commands among what is registered, as "/name". */
export function slashCommands(registered: RegisteredCommand[]): string[] {
  return registered.filter((c) => (c.type ?? 1) === 1).map((c) => `/${c.name}`);
}

/** Whether the registered slash commands are exactly this repo's. */
export function commandsInSync(registered: RegisteredCommand[]): boolean {
  const names = slashCommands(registered).sort();
  return (
    JSON.stringify(names) ===
    JSON.stringify(COMMAND_NAMES.map((n) => `/${n}`).sort())
  );
}

export function installLinks(applicationId: string): {
  server: string;
  user: string;
} {
  const link = (type: number) =>
    `https://discord.com/oauth2/authorize?client_id=${applicationId}&integration_type=${type}&scope=applications.commands`;
  return {
    server: link(ApplicationIntegrationType.GUILD_INSTALL),
    user: link(ApplicationIntegrationType.USER_INSTALL),
  };
}
