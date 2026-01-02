import { getSyncStatus, type SyncRun } from "~/app/actions/getSyncStatus";
import { isStuckRun, isZeroRecordRun, getRunHealth } from "./sync-utils";
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
  AlertCircle,
  Activity,
  Server,
  Database,
  Zap,
} from "lucide-react";
import { AdminFilters } from "./admin-filters";

export const dynamic = "force-dynamic";

interface AdminPageProps {
  searchParams: Promise<{
    environment?: string;
    showLocal?: string;
  }>;
}

function getSystemHealthStatus(runs: SyncRun[]): {
  status: "healthy" | "degraded" | "critical";
  message: string;
  issues: string[];
} {
  if (runs.length === 0) {
    return {
      status: "critical",
      message: "No sync data available",
      issues: ["No sync runs found - scheduler may not be running"],
    };
  }

  const issues: string[] = [];
  const recentRuns = runs.slice(0, 10);

  // Check for stuck runs
  const stuckRuns = recentRuns.filter(isStuckRun);
  if (stuckRuns.length > 0) {
    issues.push(`${stuckRuns.length} job(s) stuck in running state`);
  }

  // Check for failed runs
  const failedRuns = recentRuns.filter((r) => r.status === "failed");
  if (failedRuns.length > 0) {
    issues.push(`${failedRuns.length} recent job failure(s)`);
  }

  // Check for zero-record completions (suspicious)
  const zeroRecordRuns = recentRuns.filter(isZeroRecordRun);
  if (zeroRecordRuns.length >= 3) {
    issues.push(`${zeroRecordRuns.length} completed jobs with 0 records`);
  }

  // Check last successful run age
  const lastSuccessful = runs.find(
    (r) => r.status === "completed" && !isZeroRecordRun(r)
  );
  if (lastSuccessful) {
    const hoursSinceSuccess = differenceInMinutes(
      new Date(),
      new Date(lastSuccessful.startedAt)
    ) / 60;
    if (hoursSinceSuccess > 48) {
      issues.push(`No successful sync in ${Math.round(hoursSinceSuccess)} hours`);
    }
  } else {
    issues.push("No successful syncs with data found");
  }

  // Check if latest run is healthy
  const latestRun = runs[0];
  if (latestRun && getRunHealth(latestRun) === "error") {
    issues.push("Latest job has errors");
  }

  // Determine overall status
  if (
    issues.length >= 3 ||
    stuckRuns.length > 2 ||
    failedRuns.length > 3 ||
    issues.some((i) => i.includes("No successful"))
  ) {
    return {
      status: "critical",
      message: "System requires immediate attention",
      issues,
    };
  } else if (issues.length > 0) {
    return {
      status: "degraded",
      message: "System has some issues",
      issues,
    };
  }

  return {
    status: "healthy",
    message: "All systems operational",
    issues: [],
  };
}

function StatusIcon({ status }: { status: "healthy" | "degraded" | "critical" }) {
  switch (status) {
    case "healthy":
      return <CheckCircle2 className="h-5 w-5 text-emerald-500" />;
    case "degraded":
      return <AlertTriangle className="h-5 w-5 text-amber-500" />;
    case "critical":
      return <XCircle className="h-5 w-5 text-red-500" />;
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
            className="text-xs text-red-500 max-w-[150px] truncate cursor-help"
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
          <AlertCircle className="h-3 w-3" />
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
            ? "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400 text-xs"
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
  const environment = params.environment ?? "production";
  const showLocal = params.showLocal === "true";

  const runs = await getSyncStatus({
    limit: 30,
    environment: environment === "all" ? "" : environment,
    excludeLocal: !showLocal,
  });

  const systemHealth = getSystemHealthStatus(runs);

  // Calculate stats from production runs
  const lastRun = runs[0];
  const completedRuns = runs.filter((r) => r.status === "completed");
  const successfulRuns = completedRuns.filter((r) => !isZeroRecordRun(r));
  const failedRuns = runs.filter(
    (r) => r.status === "failed" || isStuckRun(r)
  );
  const stuckRuns = runs.filter(isStuckRun);

  // Find last successful run with actual data
  const lastSuccessfulWithData = runs.find(
    (r) => r.status === "completed" && !isZeroRecordRun(r)
  );

  return (
    <Container>
      <div className="space-y-6 py-8">
        {/* Header with System Status */}
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Admin Dashboard</h1>
            <p className="text-muted-foreground mt-1">
              Cloud Run job monitoring and sync status
            </p>
          </div>

          {/* System Health Badge */}
          <div
            className={`flex items-center gap-3 rounded-lg border p-3 ${
              systemHealth.status === "healthy"
                ? "border-emerald-200 bg-emerald-50 dark:border-emerald-800 dark:bg-emerald-950/30"
                : systemHealth.status === "degraded"
                  ? "border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/30"
                  : "border-red-200 bg-red-50 dark:border-red-800 dark:bg-red-950/30"
            }`}
          >
            <StatusIcon status={systemHealth.status} />
            <div>
              <div className="font-semibold text-sm capitalize">
                {systemHealth.status}
              </div>
              <div className="text-xs text-muted-foreground">
                {systemHealth.message}
              </div>
            </div>
          </div>
        </div>

        {/* Issues Alert */}
        {systemHealth.issues.length > 0 && (
          <Card className="border-amber-200 bg-amber-50/50 dark:border-amber-800 dark:bg-amber-950/20">
            <CardHeader className="pb-2">
              <CardTitle className="text-base flex items-center gap-2 text-amber-800 dark:text-amber-400">
                <AlertTriangle className="h-4 w-4" />
                Detected Issues
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="list-disc list-inside space-y-1">
                {systemHealth.issues.map((issue, i) => (
                  <li key={i} className="text-sm text-amber-700 dark:text-amber-400">
                    {issue}
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        )}

        {/* Filters */}
        <AdminFilters
          currentEnvironment={environment}
          showLocal={showLocal}
        />

        {/* Stats Cards */}
        <div className="grid gap-4 md:grid-cols-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Last Sync</CardTitle>
              <Clock className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">
                {lastRun
                  ? formatDistanceToNow(new Date(lastRun.startedAt), {
                      addSuffix: true,
                    })
                  : "Never"}
              </div>
              <p className="text-xs text-muted-foreground">
                {lastRun ? (
                  <span className="flex items-center gap-1">
                    Status: <RunHealthBadge run={lastRun} />
                  </span>
                ) : (
                  "N/A"
                )}
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Last Successful</CardTitle>
              <CheckCircle2 className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">
                {lastSuccessfulWithData
                  ? formatDistanceToNow(new Date(lastSuccessfulWithData.startedAt), {
                      addSuffix: true,
                    })
                  : "Never"}
              </div>
              <p className="text-xs text-muted-foreground">
                {lastSuccessfulWithData
                  ? `${(
                      lastSuccessfulWithData.shortsRecordsUpdated +
                      lastSuccessfulWithData.pricesRecordsUpdated +
                      lastSuccessfulWithData.metricsRecordsUpdated
                    ).toLocaleString()} records updated`
                  : "No successful syncs found"}
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Success Rate</CardTitle>
              <Zap className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">
                {runs.length > 0
                  ? Math.round((successfulRuns.length / runs.length) * 100)
                  : 0}
                %
              </div>
              <p className="text-xs text-muted-foreground">
                {successfulRuns.length} successful, {failedRuns.length} failed
                {stuckRuns.length > 0 && `, ${stuckRuns.length} stuck`}
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Records (Last)</CardTitle>
              <Database className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">
                {lastSuccessfulWithData
                  ? (
                      lastSuccessfulWithData.shortsRecordsUpdated +
                      lastSuccessfulWithData.pricesRecordsUpdated +
                      lastSuccessfulWithData.metricsRecordsUpdated
                    ).toLocaleString()
                  : 0}
              </div>
              <p className="text-xs text-muted-foreground">
                S: {lastSuccessfulWithData?.shortsRecordsUpdated ?? 0} | P:{" "}
                {lastSuccessfulWithData?.pricesRecordsUpdated ?? 0} | M:{" "}
                {lastSuccessfulWithData?.metricsRecordsUpdated ?? 0}
              </p>
            </CardContent>
          </Card>
        </div>

        {/* Sync History Table */}
        <Card>
          <CardHeader>
            <CardTitle>Sync History</CardTitle>
            <CardDescription>
              Recent Cloud Run scheduler job executions ({environment === "all" ? "all environments" : environment})
            </CardDescription>
          </CardHeader>
          <CardContent>
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
                        <EnvironmentBadge
                          environment={run.environment}
                          hostname={run.hostname}
                        />
                      </TableCell>
                    </TableRow>
                  );
                })}
                {runs.length === 0 && (
                  <TableRow>
                    <TableCell
                      colSpan={8}
                      className="text-center text-muted-foreground h-24"
                    >
                      <div className="flex flex-col items-center gap-2">
                        <Database className="h-8 w-8 text-muted-foreground/50" />
                        <span>No sync history available for selected filters.</span>
                        {environment !== "all" && (
                          <span className="text-xs">
                            Try selecting &quot;All Environments&quot; to see more data.
                          </span>
                        )}
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
