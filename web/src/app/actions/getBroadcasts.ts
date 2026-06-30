"use server";

import { cache } from "react";
import { SHORTS_API_URL } from "./config";

export interface Broadcast {
  id: string;
  type: string;
  subject: string;
  status: string;
  recipientCount: number;
  sourceRef: string;
  createdAt: string;
  sentAt: string | null;
  error: string;
}

// Internal service secret for admin endpoints (same var used by getJobsOverview.ts).
const INTERNAL_SECRET = process.env.INTERNAL_SERVICE_SECRET ?? "dev-internal-secret";

export const getBroadcasts = cache(async (): Promise<Broadcast[]> => {
  try {
    const response = await fetch(`${SHORTS_API_URL}/api/admin/broadcasts`, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${INTERNAL_SECRET}`,
        "x-internal-secret": INTERNAL_SECRET,
        "User-Agent": "Mozilla/5.0 (compatible; ShortedAdmin)",
      },
      cache: "no-store",
    });

    if (!response.ok) {
      console.error(`Failed to get broadcasts: ${response.status}`);
      return [];
    }

    const data = (await response.json()) as Broadcast[];
    return Array.isArray(data) ? data : [];
  } catch (err) {
    console.error("Failed to get broadcasts:", err);
    return [];
  }
});
