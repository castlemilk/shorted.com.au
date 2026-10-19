/**
 * Registers the Shorted bot's slash commands with Discord (docs/discord-bot.md).
 *
 *   DISCORD_APPLICATION_ID=... DISCORD_BOT_TOKEN=... npm run discord:register
 *
 *   DISCORD_GUILD_ID=...   register to one server instead of globally. A guild
 *                          command appears at once; a global one can take up
 *                          to an hour to reach every client.
 *   --dry-run              print what would be sent and stop
 *
 * Run it again after any change to src/@/lib/discord/commands.ts. It replaces
 * the app's whole command set (Discord's bulk overwrite), keeping the
 * Activity's Entry Point command if the app has one.
 *
 * The bot token is used here and nowhere else: the interactions endpoint
 * replies with each interaction's own token.
 */
import { DISCORD_API_BASE } from "../src/@/lib/discord/api";
import { COMMANDS, registrationPayload } from "../src/@/lib/discord/commands";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`${name} is not set (see docs/discord-bot.md).`);
    process.exit(2);
  }
  return value;
}

async function discord(
  method: "GET" | "PUT",
  path: string,
  token: string,
  body?: unknown,
): Promise<unknown> {
  const response = await fetch(`${DISCORD_API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bot ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "DiscordBot (https://shorted.com.au, 1.0)",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${method} ${path} -> ${response.status}: ${text}`);
  }
  return text ? (JSON.parse(text) as unknown) : null;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  if (dryRun) {
    console.log(JSON.stringify(COMMANDS, null, 2));
    return;
  }

  const applicationId = required("DISCORD_APPLICATION_ID");
  const token = required("DISCORD_BOT_TOKEN");
  const guildId = process.env.DISCORD_GUILD_ID?.trim();
  const path = guildId
    ? `/applications/${applicationId}/guilds/${guildId}/commands`
    : `/applications/${applicationId}/commands`;

  // Entry Point commands are global only, so a guild overwrite has none to keep.
  const existing = guildId
    ? []
    : ((await discord("GET", path, token)) as Record<string, unknown>[]);
  const registered = (await discord(
    "PUT",
    path,
    token,
    registrationPayload(existing),
  )) as { name: string; type: number }[];

  console.log(
    `Registered ${registered.length} command(s) ${guildId ? `to guild ${guildId}` : "globally"}: ${registered
      .map((c) => (c.type === 1 ? `/${c.name}` : `${c.name} (entry point)`))
      .join(", ")}`,
  );
  console.log(
    `Install: https://discord.com/oauth2/authorize?client_id=${applicationId}&scope=applications.commands`,
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
