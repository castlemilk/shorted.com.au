type LegacyEmailLookupCollection = "portfolios" | "watchlists";

const LEGACY_EMAIL_LOOKUP_MISS_TTL_MS = 6 * 60 * 60 * 1000;
const LEGACY_EMAIL_LOOKUP_MISS_MAX_ENTRIES = 10_000;
const legacyEmailLookupMisses = new Map<string, number>();

function legacyEmailLookupKey(
  collection: LegacyEmailLookupCollection,
  userId: string,
  userEmail: string,
) {
  return `${collection}:${userId}:${userEmail.toLowerCase()}`;
}

export function shouldTryLegacyEmailLookup(
  collection: LegacyEmailLookupCollection,
  userId: string,
  userEmail: string | null | undefined,
  now = Date.now(),
): userEmail is string {
  if (!userEmail || userId === userEmail) {
    return false;
  }

  const key = legacyEmailLookupKey(collection, userId, userEmail);
  const expiresAt = legacyEmailLookupMisses.get(key);

  if (expiresAt && expiresAt > now) {
    return false;
  }

  if (expiresAt) {
    legacyEmailLookupMisses.delete(key);
  }

  return true;
}

export function rememberLegacyEmailLookupMiss(
  collection: LegacyEmailLookupCollection,
  userId: string,
  userEmail: string,
  now = Date.now(),
) {
  legacyEmailLookupMisses.set(
    legacyEmailLookupKey(collection, userId, userEmail),
    now + LEGACY_EMAIL_LOOKUP_MISS_TTL_MS,
  );

  if (legacyEmailLookupMisses.size > LEGACY_EMAIL_LOOKUP_MISS_MAX_ENTRIES) {
    const firstKey = legacyEmailLookupMisses.keys().next().value as
      | string
      | undefined;
    if (firstKey) {
      legacyEmailLookupMisses.delete(firstKey);
    }
  }
}

export function clearLegacyEmailLookupMissCacheForTests() {
  legacyEmailLookupMisses.clear();
}
