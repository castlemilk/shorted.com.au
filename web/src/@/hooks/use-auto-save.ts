"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { type SaveStatus, type DashboardConfig } from "@/types/dashboard";

interface UseAutoSaveOptions {
  /** Debounce delay in milliseconds (default: 1500ms) */
  debounceMs?: number;
  /** Function to save the dashboard */
  onSave: (dashboard: DashboardConfig) => Promise<void>;
  /** Callback when save succeeds */
  onSaveSuccess?: () => void;
  /** Callback when save fails */
  onSaveError?: (error: Error) => void;
}

interface UseAutoSaveReturn {
  /** Current save status */
  status: SaveStatus;
  /** Last successful save timestamp */
  lastSavedAt: Date | null;
  /** Error message if save failed */
  error: string | null;
  /** Trigger a save with the current data */
  save: (dashboard: DashboardConfig) => void;
  /** Force an immediate save (skips debounce) */
  saveNow: (dashboard: DashboardConfig) => Promise<void>;
  /** Mark changes as pending (triggers debounced save) */
  markPending: (dashboard: DashboardConfig) => void;
  /** Is there unsaved data? */
  hasUnsavedChanges: boolean;
  /** Is currently online? */
  isOnline: boolean;
}

interface QueuedSave {
  dashboard: DashboardConfig;
  timestamp: number;
}

export function useAutoSave({
  debounceMs = 1500,
  onSave,
  onSaveSuccess,
  onSaveError,
}: UseAutoSaveOptions): UseAutoSaveReturn {
  const [status, setStatus] = useState<SaveStatus>("idle");
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isOnline, setIsOnline] = useState(
    typeof navigator !== "undefined" ? navigator.onLine : true
  );

  // Refs for debouncing and queuing
  const debounceTimerRef = useRef<NodeJS.Timeout | null>(null);
  const pendingDashboardRef = useRef<DashboardConfig | null>(null);
  const offlineQueueRef = useRef<QueuedSave[]>([]);
  const isSavingRef = useRef(false);

  // Process offline queue - defined before the effect that uses it
  const processOfflineQueue = useCallback(() => {
    void (async () => {
      if (offlineQueueRef.current.length === 0) return;

      // Get the most recent queued save
      const latestSave = offlineQueueRef.current.sort(
        (a, b) => b.timestamp - a.timestamp
      )[0];

      if (!latestSave) return;

      // Clear the queue
      offlineQueueRef.current = [];

      // Save the most recent version
      try {
        setStatus("saving");
        await onSave(latestSave.dashboard);
        setStatus("saved");
        setLastSavedAt(new Date());
        setError(null);
        onSaveSuccess?.();

        // Reset to idle after showing "saved" briefly
        setTimeout(() => {
          setStatus("idle");
        }, 2000);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : "Save failed";
        setStatus("error");
        setError(errorMsg);
        onSaveError?.(err instanceof Error ? err : new Error(errorMsg));
      }
    })();
  }, [onSave, onSaveSuccess, onSaveError]);

  // Track online/offline status
  useEffect(() => {
    const handleOnline = () => {
      setIsOnline(true);
      // Process offline queue when coming back online
      processOfflineQueue();
    };

    const handleOffline = () => {
      setIsOnline(false);
      setStatus("offline");
    };

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);

    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, [processOfflineQueue]);

  // Core save function
  const performSave = useCallback(
    async (dashboard: DashboardConfig) => {
      if (isSavingRef.current) return;

      // If offline, queue the save
      if (!navigator.onLine) {
        offlineQueueRef.current.push({
          dashboard,
          timestamp: Date.now(),
        });
        setStatus("offline");
        return;
      }

      isSavingRef.current = true;
      setStatus("saving");
      setError(null);

      try {
        await onSave(dashboard);
        setStatus("saved");
        setLastSavedAt(new Date());
        onSaveSuccess?.();

        // Reset to idle after showing "saved" briefly
        setTimeout(() => {
          setStatus((current) => (current === "saved" ? "idle" : current));
        }, 2000);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : "Save failed";
        setStatus("error");
        setError(errorMsg);
        onSaveError?.(err instanceof Error ? err : new Error(errorMsg));
      } finally {
        isSavingRef.current = false;

        // Check if there's a pending save that came in while we were saving
        if (pendingDashboardRef.current) {
          const pending = pendingDashboardRef.current;
          pendingDashboardRef.current = null;
          void performSave(pending);
        }
      }
    },
    [onSave, onSaveSuccess, onSaveError]
  );

  // Debounced save trigger
  const save = useCallback(
    (dashboard: DashboardConfig) => {
      setStatus("pending");
      pendingDashboardRef.current = dashboard;

      // Clear existing timer
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }

      // Set new timer
      debounceTimerRef.current = setTimeout(() => {
        if (pendingDashboardRef.current) {
          const toSave = pendingDashboardRef.current;
          pendingDashboardRef.current = null;
          void performSave(toSave);
        }
      }, debounceMs);
    },
    [debounceMs, performSave]
  );

  // Immediate save (skips debounce)
  const saveNow = useCallback(
    async (dashboard: DashboardConfig) => {
      // Clear any pending debounced save
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
      pendingDashboardRef.current = null;

      await performSave(dashboard);
    },
    [performSave]
  );

  // Mark changes as pending (alias for save with visual feedback)
  const markPending = useCallback(
    (dashboard: DashboardConfig) => {
      save(dashboard);
    },
    [save]
  );

  // Handle page unload - try to save pending changes
  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (pendingDashboardRef.current !== null || status === "pending") {
        // Note: sendBeacon could be used here for guaranteed delivery
        // but would require a beacon endpoint on the server.
        // For now, we just warn the user via the browser dialog.

        // Show browser warning
        e.preventDefault();
        const message = "You have unsaved changes. Are you sure you want to leave?";
        e.returnValue = message;
        return message;
      }
    };

    window.addEventListener("beforeunload", handleBeforeUnload);

    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
      // Cleanup timer
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, [status]);

  return {
    status,
    lastSavedAt,
    error,
    save,
    saveNow,
    markPending,
    hasUnsavedChanges: status === "pending" || pendingDashboardRef.current !== null,
    isOnline,
  };
}
