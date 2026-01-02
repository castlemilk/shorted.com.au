"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { listEnrichmentJobs } from "~/app/actions/listEnrichmentJobs";
import {
  EnrichmentJobStatus,
  type EnrichmentJob,
} from "~/gen/shorts/v1alpha1/shorts_pb";
import { RefreshCw, Loader2 } from "lucide-react";

function getStatusLabel(status: EnrichmentJobStatus) {
  switch (status) {
    case EnrichmentJobStatus.QUEUED:
      return "Queued";
    case EnrichmentJobStatus.PROCESSING:
      return "Processing";
    case EnrichmentJobStatus.COMPLETED:
      return "Completed";
    case EnrichmentJobStatus.FAILED:
      return "Failed";
    case EnrichmentJobStatus.CANCELLED:
      return "Cancelled";
    default:
      return "Unknown";
  }
}

function formatTimestamp(
  timestamp: { seconds: bigint; nanos: number } | undefined | null,
) {
  if (!timestamp) return "—";
  const date = new Date(Number(timestamp.seconds) * 1000);
  return date.toLocaleString();
}

interface JobCategoryState {
  jobs: EnrichmentJob[];
  offset: number;
  hasMore: boolean;
  isLoadingMore: boolean;
  totalCount: number;
}

const INITIAL_BATCH_SIZE = 10;
const LOAD_MORE_BATCH_SIZE = 10;

export function EnrichmentJobsStatus() {
  const [activeState, setActiveState] = useState<JobCategoryState>({
    jobs: [],
    offset: 0,
    hasMore: true,
    isLoadingMore: false,
    totalCount: 0,
  });
  const [completedState, setCompletedState] = useState<JobCategoryState>({
    jobs: [],
    offset: 0,
    hasMore: true,
    isLoadingMore: false,
    totalCount: 0,
  });
  const [failedState, setFailedState] = useState<JobCategoryState>({
    jobs: [],
    offset: 0,
    hasMore: true,
    isLoadingMore: false,
    totalCount: 0,
  });

  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);

  // Refs for infinite scroll observers
  const activeObserverTarget = useRef<HTMLDivElement>(null);
  const completedObserverTarget = useRef<HTMLDivElement>(null);
  const failedObserverTarget = useRef<HTMLDivElement>(null);

  const loadActiveJobsBatch = useCallback(
    async (isRefresh = false) => {
      if (!isRefresh && (activeState.isLoadingMore || !activeState.hasMore))
        return;

      if (!isRefresh)
        setActiveState((prev) => ({ ...prev, isLoadingMore: true }));
      try {
        const result = await listEnrichmentJobs(
          isRefresh ? INITIAL_BATCH_SIZE : LOAD_MORE_BATCH_SIZE,
          isRefresh ? 0 : activeState.offset,
          0, // 0 = all, we'll filter client side for now as the backend doesn't support multiple status filters
        );

        // Filter for active jobs (QUEUED or PROCESSING)
        const newActive = (result.jobs ?? []).filter(
          (j) =>
            j.status === EnrichmentJobStatus.QUEUED ||
            j.status === EnrichmentJobStatus.PROCESSING,
        );

        setActiveState((prev) => {
          const updatedJobs = isRefresh
            ? newActive
            : [...prev.jobs, ...newActive];
          return {
            ...prev,
            jobs: updatedJobs,
            offset: isRefresh
              ? newActive.length
              : prev.offset + newActive.length,
            // Since we filter client side, hasMore is a bit tricky.
            // We'll assume if we got fewer jobs than requested, we've reached the end of ALL jobs.
            hasMore:
              (result.jobs ?? []).length >=
              (isRefresh ? INITIAL_BATCH_SIZE : LOAD_MORE_BATCH_SIZE),
            isLoadingMore: false,
            totalCount: updatedJobs.length, // approximation
          };
        });
      } catch (error) {
        console.error("Failed to load active jobs:", error);
        if (!isRefresh)
          setActiveState((prev) => ({ ...prev, isLoadingMore: false }));
      }
    },
    [activeState.isLoadingMore, activeState.hasMore, activeState.offset],
  );

  const loadInitialJobs = useCallback(async () => {
    setIsLoading(true);
    try {
      const [completedRes, failedRes] = await Promise.all([
        listEnrichmentJobs(
          INITIAL_BATCH_SIZE,
          0,
          EnrichmentJobStatus.COMPLETED,
        ),
        listEnrichmentJobs(INITIAL_BATCH_SIZE, 0, EnrichmentJobStatus.FAILED),
      ]);

      await loadActiveJobsBatch(true);

      setCompletedState({
        jobs: completedRes.jobs ?? [],
        offset: (completedRes.jobs ?? []).length,
        hasMore:
          (completedRes.jobs ?? []).length < (completedRes.totalCount ?? 0),
        isLoadingMore: false,
        totalCount: completedRes.totalCount ?? 0,
      });

      setFailedState({
        jobs: failedRes.jobs ?? [],
        offset: (failedRes.jobs ?? []).length,
        hasMore: (failedRes.jobs ?? []).length < (failedRes.totalCount ?? 0),
        isLoadingMore: false,
        totalCount: failedRes.totalCount ?? 0,
      });
    } catch (error) {
      console.error("Failed to load initial jobs:", error);
    } finally {
      setIsLoading(false);
    }
  }, [loadActiveJobsBatch]);

  const loadMoreCompleted = useCallback(async () => {
    if (completedState.isLoadingMore || !completedState.hasMore) return;

    setCompletedState((prev) => ({ ...prev, isLoadingMore: true }));
    try {
      const result = await listEnrichmentJobs(
        LOAD_MORE_BATCH_SIZE,
        completedState.offset,
        EnrichmentJobStatus.COMPLETED,
      );
      const newJobs = result.jobs ?? [];
      setCompletedState((prev) => ({
        ...prev,
        jobs: [...prev.jobs, ...newJobs],
        offset: prev.offset + newJobs.length,
        hasMore: prev.offset + newJobs.length < (result.totalCount ?? 0),
        isLoadingMore: false,
        totalCount: result.totalCount ?? 0,
      }));
    } catch (error) {
      console.error("Failed to load more completed jobs:", error);
      setCompletedState((prev) => ({ ...prev, isLoadingMore: false }));
    }
  }, [
    completedState.isLoadingMore,
    completedState.hasMore,
    completedState.offset,
  ]);

  const loadMoreFailed = useCallback(async () => {
    if (failedState.isLoadingMore || !failedState.hasMore) return;

    setFailedState((prev) => ({ ...prev, isLoadingMore: true }));
    try {
      const result = await listEnrichmentJobs(
        LOAD_MORE_BATCH_SIZE,
        failedState.offset,
        EnrichmentJobStatus.FAILED,
      );
      const newJobs = result.jobs ?? [];
      setFailedState((prev) => ({
        ...prev,
        jobs: [...prev.jobs, ...newJobs],
        offset: prev.offset + newJobs.length,
        hasMore: prev.offset + newJobs.length < (result.totalCount ?? 0),
        isLoadingMore: false,
        totalCount: result.totalCount ?? 0,
      }));
    } catch (error) {
      console.error("Failed to load more failed jobs:", error);
      setFailedState((prev) => ({ ...prev, isLoadingMore: false }));
    }
  }, [failedState.isLoadingMore, failedState.hasMore, failedState.offset]);

  const refreshAll = useCallback(async () => {
    setIsRefreshing(true);
    await loadInitialJobs();
    setIsRefreshing(false);
  }, [loadInitialJobs]);

  useEffect(() => {
    void loadInitialJobs();
    // Poll every 10 seconds for active jobs only
    const interval = setInterval(() => {
      void loadActiveJobsBatch(true);
    }, 10000);

    return () => clearInterval(interval);
  }, [loadInitialJobs, loadActiveJobsBatch]);

  // Intersection Observers for infinite scroll
  useEffect(() => {
    const activeEl = activeObserverTarget.current;
    if (!activeEl) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          void loadActiveJobsBatch();
        }
      },
      { threshold: 0.1 },
    );

    observer.observe(activeEl);
    return () => observer.disconnect();
  }, [loadActiveJobsBatch]);

  useEffect(() => {
    const completedEl = completedObserverTarget.current;
    if (!completedEl) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          void loadMoreCompleted();
        }
      },
      { threshold: 0.1 },
    );

    observer.observe(completedEl);
    return () => observer.disconnect();
  }, [loadMoreCompleted]);

  useEffect(() => {
    const failedEl = failedObserverTarget.current;
    if (!failedEl) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          void loadMoreFailed();
        }
      },
      { threshold: 0.1 },
    );

    observer.observe(failedEl);
    return () => observer.disconnect();
  }, [loadMoreFailed]);

  const queuedJobs = activeState.jobs.filter(
    (job) => job.status === EnrichmentJobStatus.QUEUED,
  );
  const processingJobs = activeState.jobs.filter(
    (job) => job.status === EnrichmentJobStatus.PROCESSING,
  );

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Enrichment Jobs</CardTitle>
          <CardDescription>Loading...</CardDescription>
        </CardHeader>
        <CardContent className="flex justify-center py-8">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="max-h-[800px] flex flex-col">
      <CardHeader className="flex-shrink-0">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle>Enrichment Jobs</CardTitle>
            <CardDescription>
              {activeState.jobs.length} active, {completedState.totalCount}{" "}
              completed, {failedState.totalCount} failed
            </CardDescription>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={refreshAll}
            disabled={isRefreshing}
          >
            <RefreshCw
              className={`h-4 w-4 mr-2 ${isRefreshing ? "animate-spin" : ""}`}
            />
            Refresh
          </Button>
        </div>
      </CardHeader>
      <CardContent className="flex-grow overflow-y-auto space-y-6">
        {/* Active Jobs Section (Polling + Infinite Scroll) */}
        {(queuedJobs.length > 0 || processingJobs.length > 0) && (
          <div className="space-y-4">
            {queuedJobs.length > 0 && (
              <div>
                <h3 className="text-sm font-semibold mb-2 flex items-center gap-2 text-yellow-600 dark:text-yellow-400">
                  <span className="h-2 w-2 rounded-full bg-yellow-500 animate-pulse" />
                  Queued ({queuedJobs.length})
                </h3>
                <div className="space-y-2">
                  {queuedJobs.map((job) => (
                    <div
                      key={job.jobId}
                      className="flex items-center justify-between p-2 border rounded-md text-sm bg-muted/30"
                    >
                      <div className="flex items-center gap-2">
                        <Badge
                          variant="secondary"
                          className="font-normal uppercase tracking-wider text-[10px]"
                        >
                          {getStatusLabel(job.status)}
                        </Badge>
                        <span className="font-mono font-medium">
                          {job.stockCode}
                        </span>
                        <span className="text-muted-foreground text-xs">
                          {formatTimestamp(job.createdAt)}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {processingJobs.length > 0 && (
              <div>
                <h3 className="text-sm font-semibold mb-2 flex items-center gap-2 text-blue-600 dark:text-blue-400">
                  <span className="h-2 w-2 rounded-full bg-blue-500 animate-pulse" />
                  Processing ({processingJobs.length})
                </h3>
                <div className="space-y-2">
                  {processingJobs.map((job) => (
                    <div
                      key={job.jobId}
                      className="flex items-center justify-between p-2 border rounded-md text-sm bg-blue-50/10 border-blue-200/50"
                    >
                      <div className="flex items-center gap-2">
                        <Badge
                          variant="default"
                          className="font-normal uppercase tracking-wider text-[10px] bg-blue-500"
                        >
                          {getStatusLabel(job.status)}
                        </Badge>
                        <span className="font-mono font-medium">
                          {job.stockCode}
                        </span>
                        <span className="text-muted-foreground text-xs">
                          Started: {formatTimestamp(job.startedAt)}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Observer target for active jobs */}
            <div
              ref={activeObserverTarget}
              className="h-4 w-full flex justify-center py-2"
            >
              {activeState.isLoadingMore && (
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              )}
            </div>
          </div>
        )}

        {/* Completed Jobs Section (Infinite Scroll) */}
        <div className="space-y-2">
          <h3 className="text-sm font-semibold sticky top-0 bg-background/95 backdrop-blur py-1 z-10">
            Completed ({completedState.totalCount})
          </h3>
          <div className="space-y-2">
            {completedState.jobs.map((job) => (
              <div
                key={job.jobId}
                className="flex items-center justify-between p-2 border rounded-md text-sm hover:bg-muted/50 transition-colors"
              >
                <div className="flex items-center gap-2">
                  <Badge
                    variant="outline"
                    className="font-normal uppercase tracking-wider text-[10px] text-green-600 border-green-600/30 bg-green-50/10"
                  >
                    {getStatusLabel(job.status)}
                  </Badge>
                  <span className="font-mono font-medium">{job.stockCode}</span>
                  {job.enrichmentId && (
                    <span className="text-muted-foreground text-[10px] bg-muted px-1.5 py-0.5 rounded">
                      ID: {job.enrichmentId.substring(0, 8)}
                    </span>
                  )}
                </div>
                <span className="text-muted-foreground text-xs font-light">
                  {formatTimestamp(job.completedAt)}
                </span>
              </div>
            ))}

            {/* Observer target for completed jobs */}
            <div
              ref={completedObserverTarget}
              className="h-4 w-full flex justify-center py-4"
            >
              {completedState.isLoadingMore && (
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              )}
              {!completedState.hasMore && completedState.jobs.length > 0 && (
                <span className="text-[10px] text-muted-foreground italic">
                  End of list
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Failed Jobs Section (Infinite Scroll) */}
        {failedState.totalCount > 0 && (
          <div className="space-y-2">
            <h3 className="text-sm font-semibold sticky top-0 bg-background/95 backdrop-blur py-1 z-10">
              Failed ({failedState.totalCount})
            </h3>
            <div className="space-y-2">
              {failedState.jobs.map((job) => (
                <div
                  key={job.jobId}
                  className="flex flex-col p-2 border rounded-md text-sm border-red-200/30 bg-red-50/5 hover:bg-red-50/10 transition-colors"
                >
                  <div className="flex items-center justify-between w-full">
                    <div className="flex items-center gap-2">
                      <Badge
                        variant="destructive"
                        className="font-normal uppercase tracking-wider text-[10px]"
                      >
                        {getStatusLabel(job.status)}
                      </Badge>
                      <span className="font-mono font-medium">
                        {job.stockCode}
                      </span>
                    </div>
                    <span className="text-muted-foreground text-xs font-light">
                      {formatTimestamp(job.completedAt)}
                    </span>
                  </div>
                  {job.errorMessage && (
                    <p className="mt-1 text-[11px] text-red-600/80 dark:text-red-400/80 line-clamp-2 italic pl-1 border-l-2 border-red-500/20">
                      {job.errorMessage}
                    </p>
                  )}
                </div>
              ))}

              {/* Observer target for failed jobs */}
              <div
                ref={failedObserverTarget}
                className="h-4 w-full flex justify-center py-4"
              >
                {failedState.isLoadingMore && (
                  <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                )}
                {!failedState.hasMore && failedState.jobs.length > 0 && (
                  <span className="text-[10px] text-muted-foreground italic">
                    End of list
                  </span>
                )}
              </div>
            </div>
          </div>
        )}

        {activeState.jobs.length === 0 &&
          completedState.jobs.length === 0 &&
          failedState.jobs.length === 0 && (
            <div className="text-center text-sm text-muted-foreground py-12">
              No enrichment jobs found
            </div>
          )}
      </CardContent>
    </Card>
  );
}
