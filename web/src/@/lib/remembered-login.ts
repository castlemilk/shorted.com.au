/** Account hints only. Authentication always comes from a verified session. */
export type RememberedLogin = {
  email: string;
  name?: string | null;
  image?: string | null;
  method: "google" | "password";
};

export const REMEMBERED_LOGIN_KEY = "shorted:last-login:v1";
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function accountHint(value: unknown): RememberedLogin | null {
  if (!value || typeof value !== "object") return null;
  const account = value as Record<string, unknown>;
  if (
    typeof account.email !== "string" ||
    account.email.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(account.email.trim()) ||
    (account.method !== "google" && account.method !== "password")
  )
    return null;

  return {
    email: account.email.trim(),
    method: account.method,
    name: typeof account.name === "string" ? account.name.slice(0, 100) : null,
    image:
      typeof account.image === "string" && account.image.startsWith("https://")
        ? account.image.slice(0, 2048)
        : null,
  };
}

export function getRememberedLogin(): RememberedLogin | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(REMEMBERED_LOGIN_KEY);
    if (!raw) return null;
    const entry = JSON.parse(raw) as Record<string, unknown>;
    const account = accountHint(entry.account);
    const age = Date.now() - Number(entry.savedAt);
    if (
      entry.version !== 1 ||
      !account ||
      !Number.isFinite(age) ||
      age < 0 ||
      age >= MAX_AGE_MS
    ) {
      forgetRememberedLogin();
      return null;
    }
    return account;
  } catch {
    forgetRememberedLogin();
    return null;
  }
}

export function rememberLogin(value: RememberedLogin): void {
  if (typeof window === "undefined") return;
  const account = accountHint(value);
  if (!account) return;
  try {
    // Whitelist fields: passwords, tokens and permissions never enter this cache.
    window.localStorage.setItem(
      REMEMBERED_LOGIN_KEY,
      JSON.stringify({
        version: 1,
        savedAt: Date.now(),
        account,
      }),
    );
  } catch {
    // Private browsing / full storage must not prevent signing in.
  }
}

export function forgetRememberedLogin(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(REMEMBERED_LOGIN_KEY);
  } catch {
    // Storage can be unavailable in restricted browser contexts.
  }
}
