import { signOut } from "next-auth/react";
import { clearSessionCache } from "./session-cache";

const ACCOUNT_CACHE_PREFIXES = [
  "subscription",
  "dashboard",
  "watchlist",
  "portfolio",
  "account",
  "user",
] as const;

/** Firebase owns its persisted credentials; never read or delete its storage keys. */
export async function clearFirebaseSession(): Promise<void> {
  const [{ auth }, { signOut: firebaseSignOut }] = await Promise.all([
    import("./firebase-client"),
    import("firebase/auth"),
  ]);

  if (auth) {
    // Wait for a saved browser session to restore before clearing it, including
    // when sign-out runs on a page that has not loaded Firebase yet.
    await auth.authStateReady();
    await firebaseSignOut(auth);
  }
}

/** Keep public market data warm while removing data associated with an account. */
export async function clearUserSessionCaches(previousAccount?: string): Promise<void> {
  if (typeof window === "undefined") return;

  // Storage may be disabled by browser privacy settings; query cleanup should
  // still run if either storage area is unavailable.
  try {
    for (const prefix of ACCOUNT_CACHE_PREFIXES) clearSessionCache(prefix);
  } catch {
    // Storage is unavailable.
  }
  try {
    window.localStorage.removeItem("shorted_api_token");
  } catch {
    // Storage is unavailable.
  }

  const { getQueryClient } = await import("./query-client");
  const client = getQueryClient();
  const filters = {
    predicate: (query: { queryKey: readonly unknown[] }) => {
      const [prefix, scope, userId] = query.queryKey;
      if (!ACCOUNT_CACHE_PREFIXES.some((value) => prefix === value)) return false;
      // During an account switch, leave the new account's queries running.
      if (previousAccount && prefix === "subscription" && scope) {
        return scope === previousAccount;
      }
      if (previousAccount && prefix === "dashboard" && scope === "list" && userId) {
        return userId === previousAccount;
      }
      return true;
    },
  };

  // Cancel first so an old account's response cannot repopulate the cache after
  // it has been removed during sign-out or an account switch.
  await client.cancelQueries(filters);
  client.removeQueries(filters);
}

let pendingSignOut: Promise<void> | undefined;

/** Clear both authentication layers before the NextAuth redirect leaves the page. */
export function signOutFromBrowser(): Promise<void> {
  if (pendingSignOut) return pendingSignOut;

  pendingSignOut = (async () => {
    // A storage/SDK cleanup failure must not stop the server session signing out.
    await Promise.allSettled([clearFirebaseSession(), clearUserSessionCaches()]);
    await signOut({ callbackUrl: "/" });
  })().finally(() => {
    pendingSignOut = undefined;
  });

  return pendingSignOut;
}
