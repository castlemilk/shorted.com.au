import type { UserRecord } from "firebase-admin/auth";

import { adminAuth } from "~/@/lib/firebase-admin";

/**
 * Signed-up accounts for /api/internal/admin-users (the admin MCP server's
 * users:read tools). Only the fields that say who and in what state.
 */
const PAGE_SIZE = 1000;
const MAX_PAGES = 20;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface AdminUser {
  uid: string;
  email?: string;
  emailVerified: boolean;
  disabled: boolean;
  providers: string[];
  createdAt?: string;
  lastSignInAt?: string;
}

function isoDate(value?: string | null): string | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

export function toAdminUser(user: UserRecord): AdminUser {
  return {
    uid: user.uid,
    email: user.email ?? undefined,
    emailVerified: user.emailVerified,
    disabled: user.disabled,
    providers: (user.providerData ?? []).map((p) => p.providerId).sort(),
    createdAt: isoDate(user.metadata?.creationTime),
    lastSignInAt: isoDate(user.metadata?.lastSignInTime),
  };
}

export async function scanUsers(): Promise<{
  users: AdminUser[];
  truncated: boolean;
}> {
  const users: AdminUser[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await adminAuth.listUsers(PAGE_SIZE, pageToken);
    for (const u of result.users) users.push(toAdminUser(u));
    pageToken = result.pageToken;
    if (!pageToken) return { users, truncated: false };
  }
  return { users, truncated: true };
}

const time = (iso?: string) => (iso ? Date.parse(iso) : 0);

export function summarise(
  users: AdminUser[],
  truncated: boolean,
  now = Date.now(),
) {
  const byProvider: Record<string, number> = {};
  let emailVerified = 0;
  let disabled = 0;
  let signedUpLast7Days = 0;
  let signedUpLast30Days = 0;
  let signedInLast30Days = 0;
  for (const u of users) {
    if (u.emailVerified) emailVerified++;
    if (u.disabled) disabled++;
    const created = time(u.createdAt);
    if (created >= now - 7 * DAY_MS) signedUpLast7Days++;
    if (created >= now - 30 * DAY_MS) signedUpLast30Days++;
    if (time(u.lastSignInAt) >= now - 30 * DAY_MS) signedInLast30Days++;
    for (const p of u.providers) byProvider[p] = (byProvider[p] ?? 0) + 1;
  }
  return {
    total: users.length,
    emailVerified,
    disabled,
    signedUpLast7Days,
    signedUpLast30Days,
    signedInLast30Days,
    byProvider,
    truncated,
  };
}

export function page(
  users: AdminUser[],
  {
    query,
    sort,
    limit,
    offset,
  }: { query: string; sort: string; limit: number; offset: number },
) {
  const q = query.toLowerCase();
  const matched = q
    ? users.filter((u) => (u.email ?? "").toLowerCase().includes(q))
    : [...users];
  const key = sort === "last_sign_in" ? "lastSignInAt" : "createdAt";
  matched.sort(
    (a, b) => time(b[key]) - time(a[key]) || a.uid.localeCompare(b.uid),
  );
  return {
    users: matched.slice(offset, offset + limit),
    total: matched.length,
  };
}
