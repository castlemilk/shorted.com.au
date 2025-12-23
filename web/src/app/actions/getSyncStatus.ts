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

export interface SyncStatusFilter {
  limit?: number;
  environment?: string; // "production", "development", or empty for all
  excludeLocal?: boolean; // if true, exclude runs from local hostnames
}

interface SyncStatusResponse {
  runs?: SyncRun[];
}

export const getSyncStatus = cache(
  async (filter: SyncStatusFilter = {}): Promise<SyncRun[]> => {
    const { limit = 20, environment = "production", excludeLocal = true } = filter;
    
    // Use fetch directly since proto types aren't regenerated yet
    try {
      const params = new URLSearchParams({
        limit: String(limit),
        excludeLocal: String(excludeLocal),
      });
      
      // Only add environment filter if specified
      if (environment) {
        params.set("environment", environment);
      }
      
      const response = await fetch(
        `${SHORTS_API_URL}/api/admin/sync-status?${params.toString()}`,
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

      const data: SyncStatusResponse = await response.json() as SyncStatusResponse;
      return data.runs ?? [];
    } catch (err) {
      console.error("Failed to get sync status:", err);
      return [];
    }
  },
);
