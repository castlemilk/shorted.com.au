"use server";

import { cache } from "react";
import { SHORTS_API_URL } from "./config";
import { retryWithBackoff } from "@/lib/retry";

/**
 * Unified status of a single scheduled async job, as reported by the backend
 * /api/admin/jobs endpoint (which reads Cloud Run Job executions + Cloud
 * Scheduler triggers directly). Mirrors jobmonitor.JobStatus in Go.
 */
export interface JobStatus {
  name: string;
  displayName: string;
  category: string;
  type: "job" | "service";
  schedule: string;
  scheduleHuman: string;
  schedulerState: string; // ENABLED | PAUSED | ""
  lastRunAt: string; // RFC3339 or ""
  lastRunStatus: string; // succeeded | failed | running | unknown | never
  lastSuccessAt: string;
  durationSeconds: number;
  succeededCount: number;
  failedCount: number;
  runningCount: number;
  executionName: string;
  message: string;
  logUri: string;
  lastAttemptAt: string;
  health: "ok" | "running" | "warning" | "critical" | "unknown";
}

export interface JobsOverview {
  jobs: JobStatus[];
  /** true if the backend served last-known-good data after a transient error */
  stale: boolean;
  /** true if the request failed entirely (auth/network) */
  errored: boolean;
}

interface JobsResponse {
  jobs?: JobStatus[];
  stale?: boolean;
}

// Internal service secret for admin endpoints (same var used by subscription.ts).
const INTERNAL_SECRET = process.env.INTERNAL_SERVICE_SECRET ?? "dev-internal-secret";

const RETRY_OPTIONS = {
  maxRetries: 3,
  initialDelayMs: 500,
  maxDelayMs: 5000,
};

export const getJobsOverview = cache(async (): Promise<JobsOverview> => {
  try {
    const data = await retryWithBackoff<JobsResponse>(async () => {
      const response = await fetch(`${SHORTS_API_URL}/api/admin/jobs`, {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          // The backend admin endpoints require INTERNAL_SERVICE_SECRET. Send it
          // both as a bearer token and the x-internal-secret header the Go
          // middleware also accepts. A browser-like UA avoids the Cloudflare WAF
          // blocking the bare server-side fetch.
          Authorization: `Bearer ${INTERNAL_SECRET}`,
          "x-internal-secret": INTERNAL_SECRET,
          "User-Agent": "Mozilla/5.0 (compatible; ShortedAdmin)",
        },
        cache: "no-store",
      });

      if (!response.ok) {
        throw new Error(`Failed to get jobs overview: ${response.status}`);
      }

      return (await response.json()) as JobsResponse;
    }, RETRY_OPTIONS);

    return {
      jobs: data.jobs ?? [],
      stale: data.stale ?? false,
      errored: false,
    };
  } catch (err) {
    console.error("Failed to get jobs overview:", err);
    return { jobs: [], stale: false, errored: true };
  }
});
