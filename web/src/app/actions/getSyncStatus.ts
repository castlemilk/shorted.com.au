"use server";

import { cache } from "react";
import { SHORTS_API_URL } from "./config";

// Define SyncRun type locally until proto is regenerated
export interface SyncRun {
  runId: string;
  startedAt: string;
  completedAt: string;
  status: string;
  errorMessage: string;
  shortsRecordsUpdated: number;
  pricesRecordsUpdated: number;
  metricsRecordsUpdated: number;
  algoliaRecordsSynced: number;
  totalDurationSeconds: number;
  environment: string;
  hostname: string;
}

export const getSyncStatus = cache(
  async (limit: number = 10): Promise<SyncRun[]> => {
    // Use fetch directly since proto types aren't regenerated yet
    try {
      const response = await fetch(
        `${SHORTS_API_URL}/api/admin/sync-status?limit=${limit}`,
        {
          method: "GET",
          headers: {
            "Content-Type": "application/json",
          },
          cache: "no-store",
        },
      );

      if (!response.ok) {
        console.error("Failed to get sync status:", response.status);
        return [];
      }

      const data = await response.json();
      return data.runs || [];
    } catch (err) {
      console.error("Failed to get sync status:", err);
      return [];
    }
  },
);
