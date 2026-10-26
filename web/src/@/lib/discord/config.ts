import app from "~/config/discord-app.json";

/**
 * Which Discord application the bot answers for.
 *
 * The production app lives in src/config/discord-app.json, committed: its
 * application id and public key are public values (the key only VERIFIES
 * Discord's signatures), so they are configuration, reviewed like any other,
 * and `task discord:setup` writes them. Until they are filled in the endpoint
 * answers 503 and Discord will not accept its URL.
 *
 * The environment overrides the file, for a second app pointed at a preview
 * or a local tunnel:
 *
 *   DISCORD_PUBLIC_KEY        another app's public key
 *   DISCORD_ACTIVITY_ENABLED  "true" / "false"
 *
 * `activity` turns on the "Interactive" button. It is on for the production
 * app. For any other app, keep it false until that app has Activities enabled
 * and its URL mapping set (docs/discord-bot.md, "The Activity"): Discord
 * rejects a launch for an app without them.
 */

export interface DiscordAppConfig {
  applicationId: string;
  publicKey: string;
  activity: boolean;
}

const DISCORD_APP: DiscordAppConfig = app;

/**
 * Vercel has been seen to store a value with a literal "\n" on the end
 * (CLAUDE.md, "Vercel Environment Variables"); a key with one would never
 * verify a signature.
 */
function envValue(name: string): string {
  return (process.env[name] ?? "")
    .trim()
    .replace(/(\\n|\\r)+$/g, "")
    .trim();
}

function isPublicKey(value: string): boolean {
  return /^[0-9a-f]{64}$/i.test(value);
}

export function discordPublicKey(): string | null {
  const value = envValue("DISCORD_PUBLIC_KEY") || DISCORD_APP.publicKey;
  return isPublicKey(value) ? value.toLowerCase() : null;
}

export function discordActivityEnabled(): boolean {
  const value = envValue("DISCORD_ACTIVITY_ENABLED").toLowerCase();
  return value ? value === "true" : DISCORD_APP.activity;
}

/** The committed app's id, for its install links; null until it is set up. */
export function discordApplicationId(): string | null {
  return /^\d{15,22}$/.test(DISCORD_APP.applicationId)
    ? DISCORD_APP.applicationId
    : null;
}
