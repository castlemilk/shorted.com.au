import { getSyncStatus, type SyncRun } from "~/app/actions/getSyncStatus";
import { getJobsOverview, type JobsOverview as JobsOverviewData } from "~/app/actions/getJobsOverview";
import { isStuckRun, isZeroRecordRun, getRunHealth } from "./sync-utils";
import { JobsOverview } from "./jobs-overview";
import Container from "@/components/ui/container";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatDistanceToNow, differenceInMinutes } from "date-fns";
import {
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Clock,
  Activity,
  Server,
  Database,
} from "lucide-react";
import { AdminFilters } from "./admin-filters";
import { CachePanel } from "./cache-panel";

export const dynamic = "force-dynamic";

interface AdminPageProps {
  searchParams: Promise<{
    environment?: string;
    showLocal?: string;
  }>;
}

interface FleetHealth {
  status: "healthy" | "degraded" | "critical";
  message: string;
  issues: string[];
}

// getFleetHealth derives the overall banner from the all-jobs overview (the
// primary signal), not the single market-data sync_status feed.
function getFleetHealth(overview: JobsOverviewData): FleetHealth {
  if (overview.errored) {
    return {
      status: "critical",
      message: "Couldn't load job status",
      issues: ["The /api/admin/jobs call failed — see the All Async Jobs card below."],
    };
  }

  const failing = overview.jobs.filter((j) => j.health === "critical");
  const attention = overview.jobs.filter((j) => j.health === "warning");

  if (failing.length > 0) {
    return {
      status: "critical",
      message: `${failing.length} job${failing.length > 1 ? "s" : ""} failing`,
      issues: failing.map((j) => `${j.displayName}: ${j.message || "last run failed"}`),
    };
  }
  if (attention.length > 0) {
    return {
      status: "degraded",
      message: `${attention.length} job${attention.length > 1 ? "s" : ""} need attention`,
      issues: attention.map(
        (j) => `${j.displayName}: ${j.message || (j.schedulerState === "PAUSED" ? "scheduler paused" : "stale")}`,
      ),
    };
  }
  return { status: "healthy", message: "All jobs healthy", issues: [] };
}

function StatusIcon({ status }: { status: "healthy" | "degraded" | "critical" }) {
  switch (status) {
    case "healthy":
      return <CheckCircle2 className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />;
    case "degraded":
      return <AlertTriangle className="h-5 w-5 text-amber-600 dark:text-amber-400" />;
    case "critical":
      return <XCircle className="h-5 w-5 text-destructive" />;
  }
}

function RunHealthBadge({ run }: { run: SyncRun }) {
  const health = getRunHealth(run);
  const isStuck = isStuckRun(run);
  const isZeroRecord = isZeroRecordRun(run);

  if (run.status === "failed" || health === "error") {
    return (
      <div className="flex items-center gap-1.5">
        <Badge variant="destructive" className="gap-1">
          <XCircle className="h-3 w-3" />
          {isStuck ? "stuck" : "failed"}
        </Badge>
        {run.errorMessage && (
          <span
            className="text-xs text-destructive max-w-[150px] truncate cursor-help"
            title={run.errorMessage}
          >
            {run.errorMessage}
          </span>
        )}
      </div>
    );
  }

  if (run.status === "running") {
    const startedAt = new Date(run.startedAt);
    const runningMins = differenceInMinutes(new Date(), startedAt);
    const progress = run.checkpointStocksTotal > 0
      ? Math.round((run.checkpointStocksProcessed / run.checkpointStocksTotal) * 100)
      : 0;

    return (
      <div className="flex flex-col gap-2 min-w-[120px]">
        <Badge variant="outline" className="gap-1 animate-pulse">
          <Activity className="h-3 w-3" />
          running ({runningMins}m)
        </Badge>
        {run.checkpointStocksTotal > 0 && (
          <div className="space-y-1">
            <Progress value={progress} className="h-1.5" />
            <div className="flex justify-between text-[10px] text-muted-foreground">
              <span>{progress}%</span>
              <span>{run.checkpointStocksProcessed}/{run.checkpointStocksTotal}</span>
            </div>
          </div>
        )}
      </div>
    );
  }

  if (run.status === "partial") {
    const progress = run.checkpointStocksTotal > 0
      ? Math.round((run.checkpointStocksProcessed / run.checkpointStocksTotal) * 100)
      : 0;

    return (
      <div className="flex flex-col gap-2 min-w-[120px]">
        <Badge variant="secondary" className="gap-1 bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400">
          <Clock className="h-3 w-3" />
          partial
        </Badge>
        {run.checkpointStocksTotal > 0 && (
          <div className="space-y-1">
            <Progress value={progress} className="h-1.5" />
            <div className="flex justify-between text-[10px] text-muted-foreground">
              <span>{progress}%</span>
              <span>{run.checkpointStocksProcessed}/{run.checkpointStocksTotal}</span>
            </div>
          </div>
        )}
      </div>
    );
  }

  if (isZeroRecord) {
    return (
      <div className="flex items-center gap-1.5">
        <Badge
          variant="secondary"
          className="gap-1 bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400"
        >
          <AlertTriangle className="h-3 w-3" />
          0 records
        </Badge>
      </div>
    );
  }

  return (
    <Badge variant="secondary" className="gap-1 bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-400">
      <CheckCircle2 className="h-3 w-3" />
      completed
    </Badge>
  );
}

function EnvironmentBadge({ environment, hostname }: { environment: string; hostname: string }) {
  const isProduction = environment === "production";
  const isCloudRun = hostname && !hostname.includes("local") && !hostname.includes(".local");

  return (
    <div className="flex flex-col gap-0.5">
      <Badge
        variant={isProduction ? "default" : "outline"}
        className={
          isProduction
            ? "bg-primary/10 text-primary border-primary/30 text-xs"
            : "text-xs"
        }
      >
        {environment || "unknown"}
      </Badge>
      <span className="text-[10px] text-muted-foreground truncate max-w-[120px]" title={hostname}>
        {isCloudRun ? (
          <span className="flex items-center gap-0.5">
            <Server className="h-2.5 w-2.5" />
            {hostname?.slice(0, 12) || "Cloud Run"}
          </span>
        ) : (
          hostname || "local"
        )}
      </span>
    </div>
  );
}

export default async function AdminDashboard({ searchParams }: AdminPageProps) {
  const params = await searchParams;
  // Market-data sync_status detail: default to "all" because the active writer
  // (market-data-sync) leaves environment/hostname NULL, so the production
  // filter would hide every real run.
  const environment = params.environment ?? "all";
  const showLocal = params.showLocal !== "false";

  const [jobsOverview, runs] = await Promise.all([
    getJobsOverview(),
    getSyncStatus({
      limit: 20,
      environment: environment === "all" ? "" : environment,
      excludeLocal: !showLocal,
    }).then((r) => r ?? []),
  ]);

  const fleet = getFleetHealth(jobsOverview);

  // Market-data sync detail stats
  const lastSuccessfulWithData = runs.find(
    (r) => r.status === "completed" && !isZeroRecordRun(r),
  );

  return (
    <Container>
      <div className="space-y-6 py-8">
        {/* Header with fleet status */}
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Admin Dashboard</h1>
            <p className="text-muted-foreground mt-1">
              Sync status across all scheduled async jobs
            </p>
          </div>

          <div
            className={`flex items-center gap-3 rounded-lg border p-3 ${
              fleet.status === "healthy"
                ? "border-emerald-200 bg-emerald-50 dark:border-emerald-800 dark:bg-emerald-950/30"
                : fleet.status === "degraded"
                  ? "border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/30"
                  : "border-red-200 bg-red-50 dark:border-red-800 dark:bg-red-950/30"
            }`}
          >
            <StatusIcon status={fleet.status} />
            <div>
              <div className="font-semibold text-sm capitalize">{fleet.status}</div>
              <div className="text-xs text-muted-foreground">{fleet.message}</div>
            </div>
          </div>
        </div>

        {/* Issues alert */}
        {fleet.issues.length > 0 && (
          <Card className="border-amber-200 bg-amber-50/50 dark:border-amber-800 dark:bg-amber-950/20">
            <CardHeader className="pb-2">
              <CardTitle className="text-base flex items-center gap-2 text-amber-800 dark:text-amber-400">
                <AlertTriangle className="h-4 w-4" />
                Needs attention
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="list-disc list-inside space-y-1">
                {fleet.issues.map((issue, i) => (
                  <li key={i} className="text-sm text-amber-700 dark:text-amber-400 truncate" title={issue}>
                    {issue}
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        )}

        {/* PRIMARY: all async jobs */}
        <JobsOverview overview={jobsOverview} />

        {/* Cache & revalidation controls */}
        <CachePanel />

        {/* SECONDARY: market-data sync_status record detail */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Database className="h-5 w-5" />
              Market Data Sync — record detail
            </CardTitle>
            <CardDescription>
              Per-run record counts written to <code>sync_status</code> by the market-data sync
              {lastSuccessfulWithData
                ? ` · last successful ${formatDistanceToNow(new Date(lastSuccessfulWithData.startedAt), { addSuffix: true })}`
                : ""}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <AdminFilters currentEnvironment={environment} showLocal={showLocal} />
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[140px]">Status</TableHead>
                  <TableHead>Started</TableHead>
                  <TableHead className="text-right">Duration</TableHead>
                  <TableHead className="text-right">Shorts</TableHead>
                  <TableHead className="text-right">Prices</TableHead>
                  <TableHead className="text-right">Metrics</TableHead>
                  <TableHead className="text-right">Algolia</TableHead>
                  <TableHead>Environment</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {runs.map((run) => {
                  const health = getRunHealth(run);
                  return (
                    <TableRow
                      key={run.runId}
                      className={
                        health === "error"
                          ? "bg-red-50/50 dark:bg-red-950/10"
                          : health === "warning"
                            ? "bg-amber-50/50 dark:bg-amber-950/10"
                            : ""
                      }
                    >
                      <TableCell>
                        <RunHealthBadge run={run} />
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-col">
                          <span className="text-sm">
                            {new Date(run.startedAt).toLocaleDateString()}
                          </span>
                          <span className="text-xs text-muted-foreground">
                            {new Date(run.startedAt).toLocaleTimeString()}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {run.totalDurationSeconds > 0
                          ? run.totalDurationSeconds >= 60
                            ? `${Math.floor(run.totalDurationSeconds / 60)}m ${Math.round(run.totalDurationSeconds % 60)}s`
                            : `${run.totalDurationSeconds.toFixed(1)}s`
                          : "-"}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {run.shortsRecordsUpdated.toLocaleString()}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {run.pricesRecordsUpdated.toLocaleString()}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {run.metricsRecordsUpdated.toLocaleString()}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {run.algoliaRecordsSynced.toLocaleString()}
                      </TableCell>
                      <TableCell>
                        <EnvironmentBadge environment={run.environment} hostname={run.hostname} />
                      </TableCell>
                    </TableRow>
                  );
                })}
                {runs.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={8} className="text-center text-muted-foreground h-24">
                      <div className="flex flex-col items-center gap-2">
                        <Database className="h-8 w-8 text-muted-foreground/50" />
                        <span>No market-data sync runs recorded.</span>
                      </div>
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    </Container>
  );
}
