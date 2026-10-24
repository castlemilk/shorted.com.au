// Admin auth gate.
//
// Use in server components and server actions to enforce that only
// allowlisted emails can access admin routes. ADMIN_EMAILS env is a
// comma-separated list of email addresses (case-insensitive).

import { auth } from "@/auth";
import { redirect } from "next/navigation";
import { parseAdminEmails } from "./admin-emails";
import { isDevOrTestRuntime, isE2eTestEmail } from "./e2e-identity";

const ADMIN_EMAILS = parseAdminEmails(process.env.ADMIN_EMAILS);

/**
 * Whether an email is on the ADMIN_EMAILS allowlist. The single definition of
 * "admin" — the session checks below and the API's uid-based admin check
 * (/api/internal/admin-check) both go through it.
 */
export function isAdminEmail(email: string | null | undefined): boolean {
  const normalised = email?.trim().toLowerCase();
  if (!normalised) return false;
  // The E2E test identity is an admin only in a development or test runtime, even
  // when it is on ADMIN_EMAILS.
  if (isE2eTestEmail(normalised) && !isDevOrTestRuntime()) return false;
  return ADMIN_EMAILS.includes(normalised);
}

export interface AdminSession {
  email: string;
  userId: string;
}

/**
 * Throws (via redirect to /signin) if the caller is not an admin. Returns the
 * admin session on success.
 *
 * An admin is an allowlisted address with a VERIFIED email. An email/password
 * account can be registered under any address, so an unverified account under an
 * admin's address must not inherit their access. This is the same rule the
 * API's admin-check applies to a uid. A session minted before emailVerified was
 * recorded has no flag and is refused, so its holder must sign in again.
 *
 * Call this at the top of every admin server component / server action.
 */
export async function requireAdmin(): Promise<AdminSession> {
  const session = await auth();
  const email = session?.user?.email?.toLowerCase();
  if (!email) {
    redirect("/signin?callbackUrl=/admin/takes");
  }
  if (ADMIN_EMAILS.length === 0) {
    // No allowlist configured — be explicit instead of silently denying.
    throw new Error(
      "ADMIN_EMAILS is not configured. Set ADMIN_EMAILS=email1,email2 in env.",
    );
  }
  // An unverified account is refused exactly like a non-admin.
  if (!isAdminEmail(email) || session?.user?.emailVerified !== true) {
    redirect("/?adminDenied=1");
  }
  return {
    email,
    userId: session?.user?.id ?? email,
  };
}

/**
 * Lightweight check — returns whether the current session is a verified admin.
 * Same rule as requireAdmin: the allowlisted address AND a verified email.
 */
export async function isAdmin(): Promise<boolean> {
  const session = await auth();
  return (
    isAdminEmail(session?.user?.email) && session?.user?.emailVerified === true
  );
}
