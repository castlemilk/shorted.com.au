// The ADMIN_EMAILS allowlist parse. A leaf module (it imports nothing) so the
// session callback in server/auth.ts and the admin gate in server/admin.ts read
// the list the same way without importing each other.
//
// Vercel env values can carry a literal backslash-n suffix (see
// firebase-public-config.ts). In prod ADMIN_EMAILS ended in one, so its last
// address read as "ben@shorted.com.au\n" and was never an admin anywhere. An
// escaped newline, a real newline or whitespace separates entries like a comma.

export function parseAdminEmails(raw: string | undefined): string[] {
  return (raw ?? "")
    .replace(/\\[nr]/g, ",")
    .split(/[,\s]+/)
    .map((e) => e.toLowerCase())
    .filter(Boolean);
}
