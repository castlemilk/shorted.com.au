/**
 * Sets up and checks the Shorted Discord bot (docs/discord-bot.md).
 *
 *   task discord:status     what is configured, deployed and registered
 *   task discord:setup      make it so; safe to run again, and says what is left
 *   task discord:register   upload the slash commands only
 *
 * (`npm run discord -- <command>` from web/ is the same thing.)
 *
 * Needs the bot token as DISCORD_BOT_TOKEN, in the environment or in the
 * repo's .env (gitignored). The token is for this script only: the deployed
 * endpoint never needs it.
 *
 *   --guild <id>      commands to one server, where they appear at once
 *                     (global commands can take up to an hour)
 *   --endpoint <url>  another deployment or a tunnel, for a second app
 *   --wait            setup: wait for the deploy that carries the app's key
 *   --write-config    setup: replace an app already recorded in the config
 *   --dry-run         change nothing; print what would be done
 *
 * DISCORD_API_URL points it at a stand-in for Discord's API (tests).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { DISCORD_API_BASE } from "../src/@/lib/discord/api";
import { COMMANDS, registrationPayload } from "../src/@/lib/discord/commands";
import type { DiscordAppConfig } from "../src/@/lib/discord/config";
import {
  DEFAULT_ENDPOINT,
  applicationPatch,
  commandsInSync,
  configAction,
  endpointVerdict,
  installLinks,
  parseEndpointStatus,
  slashCommands,
  type DiscordApplication,
  type EndpointStatus,
  type EndpointVerdict,
  type RegisteredCommand,
} from "../src/@/lib/discord/setup";

const WEB = join(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG_FILE = join(WEB, "src/config/discord-app.json");
const ICON_FILE = join(WEB, "public/icon-512.png");

for (const file of [join(WEB, "..", ".env"), join(WEB, ".env.local")]) {
  try {
    process.loadEnvFile(file);
  } catch {
    // No such file: the environment alone will do.
  }
}

const args = process.argv.slice(2);
const command = args.find((a) => !a.startsWith("--")) ?? "status";
const has = (flag: string) => args.includes(flag);
const value = (flag: string) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};

const dryRun = has("--dry-run");
const guildId = value("--guild") ?? process.env.DISCORD_GUILD_ID?.trim();
const endpointUrl = value("--endpoint") ?? DEFAULT_ENDPOINT;
const token = process.env.DISCORD_BOT_TOKEN?.trim();
const api = process.env.DISCORD_API_URL?.trim() || DISCORD_API_BASE;

const ok = (text: string) => console.log(`  ✓ ${text}`);
const todo = (text: string) => console.log(`  ✗ ${text}`);
const note = (text: string) => console.log(`  · ${text}`);

class Stop extends Error {}

function requireToken(): string {
  if (!token) {
    throw new Stop(
      "DISCORD_BOT_TOKEN is not set. Developer portal > your app > Bot > Reset Token, then add DISCORD_BOT_TOKEN=... to the repo's .env.",
    );
  }
  return token;
}

async function discord<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const response = await fetch(`${api}${path}`, {
    method,
    headers: {
      Authorization: `Bot ${requireToken()}`,
      "Content-Type": "application/json",
      "User-Agent": "DiscordBot (https://shorted.com.au, 1.0)",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (response.status === 401) {
    throw new Stop(
      "Discord rejected DISCORD_BOT_TOKEN (401). Reset it in the portal and update .env.",
    );
  }
  if (!response.ok) {
    throw new Stop(
      `Discord ${method} ${path} answered ${response.status}: ${text.slice(0, 500)}`,
    );
  }
  return (text ? JSON.parse(text) : null) as T;
}

interface Live {
  status: EndpointStatus | null;
  /** Why there is no status, when there is none. */
  detail: string;
}

async function endpointStatus(): Promise<Live> {
  try {
    const response = await fetch(endpointUrl, {
      headers: { Accept: "application/json" },
    });
    if (response.headers.get("cf-mitigated") === "challenge") {
      return {
        status: null,
        detail:
          "Cloudflare challenged the request: the /api/discord/ bot-fight skip is not applied yet",
      };
    }
    const status = parseEndpointStatus(await response.json().catch(() => null));
    return {
      status,
      detail: status
        ? ""
        : `HTTP ${response.status}, not the bot (not deployed yet?)`,
    };
  } catch (error) {
    return {
      status: null,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

function describeEndpoint(verdict: EndpointVerdict, detail: string): string {
  switch (verdict) {
    case "ready":
      return `${endpointUrl} verifies this app's requests`;
    case "unconfigured":
      return `${endpointUrl} is live but has no key: deploy the config`;
    case "other-key":
      return `${endpointUrl} holds another app's key`;
    case "unreachable":
      return `${endpointUrl} did not answer: ${detail}`;
  }
}

function readConfig(): DiscordAppConfig {
  return JSON.parse(readFileSync(CONFIG_FILE, "utf8")) as DiscordAppConfig;
}

function iconDataUri(): string {
  return `data:image/png;base64,${readFileSync(ICON_FILE).toString("base64")}`;
}

function commandsPath(app: DiscordApplication): string {
  return guildId
    ? `/applications/${app.id}/guilds/${guildId}/commands`
    : `/applications/${app.id}/commands`;
}

async function registerCommands(app: DiscordApplication): Promise<void> {
  const path = commandsPath(app);
  const where = guildId ? `to server ${guildId}` : "globally";
  if (dryRun) {
    note(`would register ${COMMANDS.length} commands ${where}`);
    return;
  }
  // Entry Point commands are global only, so a guild overwrite has none to keep.
  const existing = guildId
    ? []
    : await discord<Record<string, unknown>[]>("GET", path);
  const registered = await discord<RegisteredCommand[]>(
    "PUT",
    path,
    registrationPayload(existing),
  );
  ok(`commands ${where}: ${slashCommands(registered).join(" ")}`);
}

function printInstall(app: DiscordApplication): void {
  const links = installLinks(app.id);
  console.log("\nInstall:");
  console.log(`  to a server   ${links.server}`);
  console.log(`  to your apps  ${links.user}`);
}

async function status(): Promise<number> {
  console.log("Shorted Discord bot\n");
  const config = readConfig();
  if (config.applicationId) {
    ok(
      `config: app ${config.applicationId}${config.activity ? ", Activity on" : ""}`,
    );
  } else {
    todo("config: no app recorded in web/src/config/discord-app.json");
  }

  const live = await endpointStatus();
  if (!token) {
    // Without the app's own key, report what the endpoint says it holds.
    const key = live.status?.publicKey;
    if (key) ok(`${endpointUrl} is live with key ${key.slice(0, 12)}...`);
    else
      todo(
        describeEndpoint(
          live.status ? "unconfigured" : "unreachable",
          live.detail,
        ),
      );
    note("set DISCORD_BOT_TOKEN to check the Discord side");
    return 0;
  }

  const app = await discord<DiscordApplication>("GET", "/applications/@me");
  ok(`Discord app "${app.name}" (${app.id})`);
  if (configAction(app, config).kind !== "current") {
    todo("config does not match this app: run `task discord:setup`");
  }
  const verdict = endpointVerdict(live.status, app);
  (verdict === "ready" ? ok : todo)(describeEndpoint(verdict, live.detail));
  (app.interactions_endpoint_url === endpointUrl ? ok : todo)(
    `Interactions Endpoint URL: ${app.interactions_endpoint_url || "not set"}`,
  );
  const registered = await discord<RegisteredCommand[]>(
    "GET",
    commandsPath(app),
  );
  (commandsInSync(registered) ? ok : todo)(
    `commands${guildId ? ` in server ${guildId}` : ""}: ${slashCommands(registered).join(" ") || "none"}`,
  );
  printInstall(app);
  return 0;
}

/** Polls the endpoint until it carries the app's key, for up to 45 minutes. */
async function waitForDeploy(app: DiscordApplication): Promise<Live> {
  const deadline = Date.now() + 45 * 60_000;
  let last = "";
  for (;;) {
    const live = await endpointStatus();
    const verdict = endpointVerdict(live.status, app);
    if (verdict === "ready" || Date.now() > deadline) return live;
    const line = describeEndpoint(verdict, live.detail);
    if (line !== last) note(`waiting: ${line}`);
    last = line;
    await new Promise((r) => setTimeout(r, 20_000));
  }
}

async function setup(): Promise<number> {
  console.log(
    `Setting up the Shorted Discord bot${dryRun ? " (dry run)" : ""}\n`,
  );
  const app = await discord<DiscordApplication>("GET", "/applications/@me");
  ok(`Discord app "${app.name}" (${app.id})`);

  // 1. The repo records the app, so the deployed endpoint can verify it.
  const config = readConfig();
  const action = configAction(app, config);
  if (action.kind === "other-app" && !has("--write-config")) {
    todo(
      `the config records app ${config.applicationId}, not this one. For a second app (a preview or a tunnel) pass --endpoint and set DISCORD_PUBLIC_KEY there; to switch production's bot, pass --write-config.`,
    );
    return 1;
  }
  if (action.kind !== "current") {
    if (!dryRun) {
      writeFileSync(CONFIG_FILE, `${JSON.stringify(action.config, null, 2)}\n`);
    }
    ok(
      `${dryRun ? "would record" : "recorded"} the app in web/src/config/discord-app.json`,
    );
  }

  // 2. Discord checks the endpoint when it is set, so it must be live first.
  let live = await endpointStatus();
  if (
    endpointVerdict(live.status, app) !== "ready" &&
    has("--wait") &&
    !dryRun
  ) {
    live = await waitForDeploy(app);
  }
  const verdict = endpointVerdict(live.status, app);
  if (verdict !== "ready") {
    todo(describeEndpoint(verdict, live.detail));
    console.log(
      action.kind === "current"
        ? "\nNext: deploy main (the config is already committed), then run this again, or run it with --wait."
        : "\nNext: commit web/src/config/discord-app.json and merge it to main. Then run this again (or now, with --wait).",
    );
    return 1;
  }
  ok(describeEndpoint(verdict, ""));

  // 3. Point Discord at it, install as commands only, and fill in what is blank.
  const patch = applicationPatch(app, {
    endpointUrl,
    icon: app.icon ? undefined : iconDataUri(),
  });
  const fields = Object.keys(patch);
  if (fields.length === 0) {
    ok("application settings already current");
  } else if (dryRun) {
    note(`would update: ${fields.join(", ")}`);
  } else {
    await discord("PATCH", "/applications/@me", patch);
    ok(`updated ${fields.join(", ")}`);
  }

  // 4. The commands.
  await registerCommands(app);

  printInstall(app);
  if (!config.activity) {
    console.log(
      '\nOptional: the in-Discord interactive chart (Activity). See docs/discord-bot.md, "The Activity".',
    );
  }
  return 0;
}

async function register(): Promise<number> {
  if (dryRun) {
    console.log(JSON.stringify(COMMANDS, null, 2));
    return 0;
  }
  const app = await discord<DiscordApplication>("GET", "/applications/@me");
  await registerCommands(app);
  return 0;
}

const commands: Record<string, () => Promise<number>> = {
  status,
  setup,
  register,
};

const run = commands[command];
if (!run) {
  console.error(`Unknown command "${command}". Use: status | setup | register`);
  process.exit(2);
}
run().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Stop ? error.message : error);
    process.exit(1);
  },
);
