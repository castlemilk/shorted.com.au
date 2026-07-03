"use server";

import { SHORTS_API_URL } from "./config";
import { requireAdmin } from "~/server/admin";

// Internal service secret for admin endpoints (same var used by getJobsOverview.ts).
const INTERNAL_SECRET = process.env.INTERNAL_SERVICE_SECRET ?? "dev-internal-secret";

export async function sendBroadcast(
  id: string,
  to?: string,
): Promise<{ ok: boolean; error?: string }> {
  // Admin-only. Gate in-action (server actions are globally addressable by
  // action-id, so the /admin route middleware is not a sufficient boundary).
  await requireAdmin();
  try {
    // When `to` is set the backend delivers only to that one address (a test
    // send): it must be an active subscriber, the subscriber list is untouched,
    // and the broadcast stays a draft (not marked sent).
    const testParam = to ? `&to=${encodeURIComponent(to)}` : "";
    const response = await fetch(
      `${SHORTS_API_URL}/api/admin/broadcasts/send?id=${encodeURIComponent(id)}${testParam}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${INTERNAL_SECRET}`,
          "x-internal-secret": INTERNAL_SECRET,
          "User-Agent": "Mozilla/5.0 (compatible; ShortedAdmin)",
        },
        cache: "no-store",
      },
    );

    if (!response.ok) {
      const text = await response.text();
      return { ok: false, error: text || `HTTP ${response.status}` };
    }

    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
