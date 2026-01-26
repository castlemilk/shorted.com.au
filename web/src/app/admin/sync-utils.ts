import type { SyncRun } from "~/app/actions/getSyncStatus";

/**
 * Checks if a sync run is potentially stuck (running for too long)
 * Cloud Run jobs have a 1 hour timeout, so anything running > 70 mins is stuck
 */
export function isStuckRun(run: SyncRun): boolean {
  if (run.status !== "running") return false;
  const startedAt = new Date(run.startedAt);
  const now = new Date();
  const runningMinutes = (now.getTime() - startedAt.getTime()) / (1000 * 60);
  return runningMinutes > 70; // 70 minutes = job timeout + buffer
}

/**
 * Checks if a completed run has suspicious zero records (potential failure)
 */
export function isZeroRecordRun(run: SyncRun): boolean {
  if (run.status !== "completed") return false;
  const totalRecords = 
    run.shortsRecordsUpdated + 
    run.pricesRecordsUpdated + 
    run.metricsRecordsUpdated;
  return totalRecords === 0;
}

/**
 * Determines the health status of a run
 */
export function getRunHealth(run: SyncRun): "healthy" | "warning" | "error" {
  if (run.status === "failed" || run.errorMessage) return "error";
  if (isStuckRun(run)) return "error";
  if (isZeroRecordRun(run)) return "warning";
  if (run.status === "completed") return "healthy";
  return "warning"; // running status is neutral/warning
}

