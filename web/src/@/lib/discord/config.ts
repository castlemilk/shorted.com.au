/**
 * The bot's server-side configuration. None of it is NEXT_PUBLIC_: the public
 * key only verifies requests and nothing here belongs in a client bundle.
 *
 *   DISCORD_PUBLIC_KEY        the application's public key (developer portal,
 *                             General Information). Unset, the endpoint answers
 *                             503 and Discord will not accept its URL.
 *   DISCORD_ACTIVITY_ENABLED  "true" once Activities are enabled for the app
 *                             and its URL mapping points at shorted.com.au
 *                             (docs/discord-bot.md). Until then the chart
 *                             message offers no "Interactive" button, because
 *                             Discord rejects a launch for an app without one.
 */

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

export function discordPublicKey(): string | null {
  const value = envValue("DISCORD_PUBLIC_KEY");
  return /^[0-9a-f]{64}$/i.test(value) ? value : null;
}

export function discordActivityEnabled(): boolean {
  return envValue("DISCORD_ACTIVITY_ENABLED").toLowerCase() === "true";
}
