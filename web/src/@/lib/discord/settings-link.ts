import { createHmac, timingSafeEqual } from "node:crypto";

import { siteConfig } from "~/@/config/site";
import { isSnowflake, type SettingsScope } from "./settings";

/**
 * The link `/settings` hands out: a signed, short-lived grant to change one
 * scope's settings on the web page (app/discord/settings).
 *
 * Discord has already decided who may change what: the interaction is signed,
 * and a member's permissions in it are Discord's own. So the bot signs that
 * decision into the link, and the page needs no Discord sign-in of its own
 * (no OAuth flow, no client secret on the deployment). The link works for 30
 * minutes, for anyone who has it, which is why `/settings` answers privately.
 *
 * The link opens /discord/settings/open, which moves the token into an
 * httpOnly cookie scoped to the page and redirects to the page's clean URL,
 * so the token never sits in an address bar, the history, or the page URL
 * that analytics records.
 *
 *   v1.<base64url JSON {s: "guild"|"user", i: id, b: by, e: expiry s}>.<base64url HMAC>
 *
 * The key is derived from NEXTAUTH_SECRET under a label of its own, so the
 * deployment needs no new secret, and nothing else signed with that secret can
 * be replayed as a grant.
 */

export interface SettingsGrant {
  scope: SettingsScope;
  /** The Discord user the grant was made for. */
  by: string;
  /** Seconds since the epoch. */
  expiresAt: number;
}

export const SETTINGS_LINK_TTL_S = 30 * 60;

const VERSION = "v1";
const KEY_LABEL = "shorted:discord-settings:v1";

/** The signing key, or null when the deployment has no NEXTAUTH_SECRET. */
export function settingsLinkKey(): Buffer | null {
  const secret = (
    process.env.NEXTAUTH_SECRET ??
    process.env.AUTH_SECRET ??
    ""
  ).trim();
  if (!secret) return null;
  return createHmac("sha256", secret).update(KEY_LABEL).digest();
}

function mac(key: Buffer, body: string): string {
  return createHmac("sha256", key)
    .update(`${VERSION}.${body}`)
    .digest("base64url");
}

export function signSettingsGrant(grant: SettingsGrant, key: Buffer): string {
  const body = Buffer.from(
    JSON.stringify({
      s: grant.scope.kind,
      i: grant.scope.id,
      b: grant.by,
      e: grant.expiresAt,
    }),
  ).toString("base64url");
  return `${VERSION}.${body}.${mac(key, body)}`;
}

/** The grant a token carries, or null when it is forged, malformed or expired. */
export function verifySettingsToken(
  token: string | null | undefined,
  key: Buffer,
  now: number,
): SettingsGrant | null {
  if (!token || token.length > 512) return null;
  const [version, body, signature] = token.split(".");
  if (version !== VERSION || !body || !signature) return null;
  const expected = Buffer.from(mac(key, body));
  const given = Buffer.from(signature);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return null;
  }
  let fields: Record<string, unknown>;
  try {
    fields = JSON.parse(
      Buffer.from(body, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
  } catch {
    return null;
  }
  const { s, i, b, e } = fields;
  if (
    (s !== "guild" && s !== "user") ||
    !isSnowflake(i) ||
    !isSnowflake(b) ||
    typeof e !== "number" ||
    !Number.isSafeInteger(e) ||
    e < now
  ) {
    return null;
  }
  return { scope: { kind: s, id: i }, by: b, expiresAt: e };
}

/** The cookie that carries the token on the settings page and its actions. */
export const SETTINGS_COOKIE = "shorted_discord_settings";
export const SETTINGS_PAGE_PATH = "/discord/settings";

export function settingsPageUrl(token: string): string {
  return `${siteConfig.url}${SETTINGS_PAGE_PATH}/open?t=${encodeURIComponent(token)}`;
}

/** The grant a token carries now, with this deployment's key; null without one. */
export function readSettingsGrant(
  token: string | null | undefined,
  now = Math.floor(Date.now() / 1000),
): SettingsGrant | null {
  const key = settingsLinkKey();
  return key ? verifySettingsToken(token, key, now) : null;
}
