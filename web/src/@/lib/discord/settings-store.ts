import { adminDb } from "~/@/lib/firebase-admin-db";
import { withFirestoreCost } from "~/@/lib/firestore-cost";
import {
  parseSettings,
  scopeKey,
  type DiscordSettings,
  type SettingsScope,
} from "./settings";

/**
 * Where servers' and people's bot settings live: Firestore collection
 * `discord_settings`, one document per scope (`guild:<id>`, `user:<id>`), like
 * the site's dashboards and portfolios.
 *
 * Reads fail open: a missing document, an unreadable one or an unreachable
 * Firestore all read as "nothing set", so a chart falls back to the next layer
 * and never fails over a setting. Each instance keeps what it read for a
 * minute, so a busy server costs one read a minute, and a change made on
 * another instance shows within that minute.
 */
export interface SettingsStore {
  /** `fresh` skips this instance's cache: the settings page edits what is stored. */
  get(
    scope: SettingsScope,
    options?: { fresh?: boolean },
  ): Promise<Partial<DiscordSettings> | null>;
  put(
    scope: SettingsScope,
    settings: DiscordSettings,
    by: string,
  ): Promise<void>;
}

export const SETTINGS_COLLECTION = "discord_settings";
const CACHE_TTL_MS = 60_000;
const CACHE_MAX = 5_000;

const cache = new Map<
  string,
  { value: Partial<DiscordSettings> | null; expires: number }
>();

function remember(key: string, value: Partial<DiscordSettings> | null): void {
  if (cache.size >= CACHE_MAX) cache.clear();
  cache.set(key, { value, expires: Date.now() + CACHE_TTL_MS });
}

/** Tests only. */
export function clearSettingsCache(): void {
  cache.clear();
}

export const firestoreSettingsStore: SettingsStore = {
  async get(scope, options) {
    const key = scopeKey(scope);
    const hit = cache.get(key);
    if (!options?.fresh && hit && hit.expires > Date.now()) return hit.value;
    try {
      const snapshot = await withFirestoreCost(
        {
          feature: "discord",
          collection: SETTINGS_COLLECTION,
          operation: "doc_get",
          documentsRead: 1,
        },
        () => adminDb.collection(SETTINGS_COLLECTION).doc(key).get(),
      );
      const value = snapshot.exists ? parseSettings(snapshot.data()) : null;
      remember(key, value);
      return value;
    } catch (error) {
      console.error(`[discord] settings read failed for ${key}:`, error);
      return null;
    }
  },

  async put(scope, settings, by) {
    const key = scopeKey(scope);
    await withFirestoreCost(
      {
        feature: "discord",
        collection: SETTINGS_COLLECTION,
        operation: "set",
        documentsWritten: 1,
      },
      () =>
        adminDb
          .collection(SETTINGS_COLLECTION)
          .doc(key)
          .set({
            ...settings,
            scope: scope.kind,
            scopeId: scope.id,
            updatedBy: by,
            updatedAt: new Date(),
          }),
    );
    remember(key, { ...settings });
  },
};
