"use server";

import { SHORTS_API_URL } from "./config";

// Internal service secret for admin endpoints (same var used by getJobsOverview.ts).
const INTERNAL_SECRET = process.env.INTERNAL_SERVICE_SECRET ?? "dev-internal-secret";

export async function sendBroadcast(
  id: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const response = await fetch(
      `${SHORTS_API_URL}/api/admin/broadcasts/send?id=${encodeURIComponent(id)}`,
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
