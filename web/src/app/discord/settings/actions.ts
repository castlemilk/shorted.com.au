"use server";

import { cookies } from "next/headers";

import { normalizeCode } from "~/@/lib/discord/custom-id";
import { discordData } from "~/@/lib/discord/data";
import type { StockHit, StockSummary } from "~/@/lib/discord/messages";
import {
  parseSettings,
  resolveSettings,
  type DiscordSettings,
} from "~/@/lib/discord/settings";
import {
  SETTINGS_COOKIE,
  readSettingsGrant,
  type SettingsGrant,
} from "~/@/lib/discord/settings-link";
import { firestoreSettingsStore } from "~/@/lib/discord/settings-store";

/**
 * The settings page's two actions. Each one reads the grant from the cookie
 * the link set (open/route.ts) and checks it again, so a form left open past
 * the link's 30 minutes cannot save, and nothing the browser sends decides
 * whose settings change: the scope and the person are the grant's.
 */

export type SaveResult =
  | { ok: true; settings: DiscordSettings }
  | { ok: false; error: string; expired?: true };

// A "use server" module exports async functions only, so the form keeps its
// own copy of this line (settings-form.tsx).
const EXPIRED_MESSAGE =
  "This link has expired. Run /settings in Discord for a new one.";

function currentGrant(): SettingsGrant | null {
  return readSettingsGrant(cookies().get(SETTINGS_COOKIE)?.value);
}

export async function saveDiscordSettings(input: unknown): Promise<SaveResult> {
  const grant = currentGrant();
  if (!grant) return { ok: false, error: EXPIRED_MESSAGE, expired: true };

  // The form sends all four. One that is missing or not valid is refused
  // rather than filled from the defaults, which would save a setting nobody
  // chose.
  const parsed = parseSettings(input);
  if (
    parsed.code === undefined ||
    parsed.view === undefined ||
    parsed.period === undefined ||
    parsed.interactive === undefined
  ) {
    return {
      ok: false,
      error:
        "Some of these settings are not valid. Reload the page and try again.",
    };
  }
  const settings = resolveSettings(parsed);

  // A default stock that does not exist would make every command without a
  // code answer "not found".
  if (settings.code && !(await discordData.stockSummary(settings.code))) {
    return {
      ok: false,
      error: `Couldn't find ${settings.code}. Pick a stock from the search.`,
    };
  }

  try {
    await firestoreSettingsStore.put(grant.scope, settings, grant.by);
  } catch (error) {
    console.error("[discord] settings save failed:", error);
    return {
      ok: false,
      error: "Couldn't save just now. Try again in a moment.",
    };
  }
  return { ok: true, settings };
}

/** The default stock picker's search: codes and names, as `/stock` suggests them. */
export async function searchDiscordStocks(query: unknown): Promise<StockHit[]> {
  if (typeof query !== "string" || !currentGrant()) return [];
  const q = query.trim().slice(0, 60);
  return q ? discordData.search(q, 8) : [];
}

/** A stock summary that crosses to the browser: the as-of date as ISO text. */
export type PreviewSummary = Omit<StockSummary, "asOf"> & {
  asOf: string | null;
};

/** The readings the preview's chart message carries, as the bot would post them. */
export async function previewStock(
  code: unknown,
): Promise<PreviewSummary | null> {
  const c = typeof code === "string" ? normalizeCode(code) : null;
  if (!c || !currentGrant()) return null;
  const summary = await discordData.stockSummary(c);
  return summary
    ? { ...summary, asOf: summary.asOf ? summary.asOf.toISOString() : null }
    : null;
}
