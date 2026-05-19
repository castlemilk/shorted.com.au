// Admin auth gate.
//
// Use in server components and server actions to enforce that only
// allowlisted emails can access admin routes. ADMIN_EMAILS env is a
// comma-separated list of email addresses (case-insensitive).

import { auth } from "@/auth";
import { redirect } from "next/navigation";

const ADMIN_EMAILS = (process.env.ADMIN_EMAILS ?? "")
  .split(",")
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

export interface AdminSession {
  email: string;
  userId: string;
}

/**
 * Throws (via redirect to /signin) if the caller is not in the admin
 * allowlist. Returns the verified admin session on success.
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
  if (!ADMIN_EMAILS.includes(email)) {
    redirect("/?adminDenied=1");
  }
  return {
    email,
    userId: session?.user?.id ?? email,
  };
}

/** Lightweight check — returns whether the current session is admin. */
export async function isAdmin(): Promise<boolean> {
  const session = await auth();
  const email = session?.user?.email?.toLowerCase();
  return !!email && ADMIN_EMAILS.includes(email);
}
