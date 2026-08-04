import type { JobsOverview as JobsOverviewData, JobStatus } from "~/app/actions/getJobsOverview";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatDistanceToNow } from "date-fns";
import {
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Clock,
  Activity,
  HelpCircle,
  ExternalLink,
  ServerCog,
  CalendarClock,
} from "lucide-react";

function relative(ts: string): string {
  if (!ts) return "Never";
  const d = new Date(ts);
  if (isNaN(d.getTime())) return "Never";
  return formatDistanceToNow(d, { addSuffix: true });
}

function duration(seconds: number): string {
  if (!seconds || seconds <= 0) return "–";
  if (seconds >= 60) {
    return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
  }
  return `${seconds.toFixed(1)}s`;
}

// typeLabel describes a job's source in the "category · source" subtitle.
function typeLabel(type: JobStatus["type"]): string {
  switch (type) {
    case "service":
      return "scheduled service";
    case "rig":
      return "residential rig";
    default:
      return "Cloud Run job";
  }
}

function statusLabel(job: JobStatus): string {
  switch (job.health) {
    case "critical":
      // A rig that has gone silent past the dead-rig horizon is "offline", not "failed".
      if (job.type === "rig" && job.lastRunStatus !== "failed") return "offline";
      return "failed";
    case "running":
      return "running";
    case "warning":
      if (job.lastRunStatus === "running") return "stuck?";
      if (job.schedulerState === "PAUSED") return "paused";
      // Rig warnings are degraded/overdue runs, not the GCP "stale" cadence miss.
      if (job.type === "rig") return "attention";
      return "stale";
    case "unknown":
      return job.lastRunStatus === "never" ? "never run" : "no data";
    default:
      return "ok";
  }
}

function JobHealthBadge({ job }: { job: JobStatus }) {
  const label = statusLabel(job);
  switch (job.health) {
    case "critical":
      return (
        <Badge variant="destructive" className="gap-1">
          <XCircle className="h-3 w-3" />
          {label}
        </Badge>
      );
    case "running":
      return (
        <Badge variant="outline" className="gap-1 animate-pulse border-primary/40 text-primary">
          <Activity className="h-3 w-3" />
          {label}
        </Badge>
      );
    case "warning":
      return (
        <Badge
          variant="secondary"
          className="gap-1 bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400"
        >
          <AlertTriangle className="h-3 w-3" />
          {label}
        </Badge>
      );
    case "unknown":
      return (
        <Badge variant="outline" className="gap-1 text-muted-foreground">
          <HelpCircle className="h-3 w-3" />
          {label}
        </Badge>
      );
    default:
      return (
        <Badge
          variant="secondary"
          className="gap-1 bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-400"
        >
          <CheckCircle2 className="h-3 w-3" />
          {label}
        </Badge>
      );
  }
}

function StatCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "ok" | "critical" | "warning" | "muted";
}) {
  const toneClass =
    tone === "critical"
      ? "text-red-700 dark:text-red-400"
      : tone === "warning"
        ? "text-amber-600 dark:text-amber-400"
        : tone === "ok"
          ? "text-emerald-700 dark:text-emerald-400"
          : "text-foreground";
  return (
    <Card>
      <CardContent className="pt-6">
        <div className={`text-3xl font-bold tabular-nums ${toneClass}`}>{value}</div>
        <p className="text-xs text-muted-foreground mt-1">{label}</p>
      </CardContent>
    </Card>
  );
}

export function JobsOverview({ overview }: { overview: JobsOverviewData }) {
  const { jobs, stale, errored } = overview;

  const counts = {
    total: jobs.length,
    ok: jobs.filter((j) => j.health === "ok").length,
    failing: jobs.filter((j) => j.health === "critical").length,
    attention: jobs.filter((j) => j.health === "warning" || j.health === "running").length,
    unknown: jobs.filter((j) => j.health === "unknown").length,
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <ServerCog className="h-5 w-5" />
              All Async Jobs
            </CardTitle>
            <CardDescription>
              Live status of every scheduled job &amp; sync from Cloud Run + Cloud Scheduler
            </CardDescription>
          </div>
          {stale && (
            <Badge variant="outline" className="gap-1 text-amber-600 dark:text-amber-400 w-fit">
              <Clock className="h-3 w-3" />
              showing cached data
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {errored ? (
          <div className="flex flex-col items-center gap-2 py-10 text-center text-muted-foreground">
            <AlertTriangle className="h-8 w-8 text-amber-600 dark:text-amber-400" />
            <span className="font-medium">Couldn&apos;t load job status</span>
            <span className="text-xs max-w-md">
              The backend /api/admin/jobs call failed. Confirm INTERNAL_SERVICE_SECRET is set in the
              web app, the shorts service is deployed with the endpoint, and its service account has
              the Cloud Run Viewer + Cloud Scheduler Viewer roles.
            </span>
          </div>
        ) : (
          <>
            {/* Summary */}
            <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
              <StatCard label="Total jobs" value={counts.total} tone="muted" />
              <StatCard label="Healthy" value={counts.ok} tone="ok" />
              <StatCard label="Failing" value={counts.failing} tone="critical" />
              <StatCard label="Needs attention" value={counts.attention} tone="warning" />
              <StatCard label="No data" value={counts.unknown} tone="muted" />
            </div>

            {/* Table */}
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[120px]">Status</TableHead>
                  <TableHead>Job</TableHead>
                  <TableHead>Schedule</TableHead>
                  <TableHead>Last run</TableHead>
                  <TableHead className="text-right">Duration</TableHead>
                  <TableHead className="w-[60px]">Logs</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {jobs.map((job) => (
                  <TableRow
                    key={job.name}
                    className={
                      job.health === "critical"
                        ? "bg-red-50/50 dark:bg-red-950/10"
                        : job.health === "warning"
                          ? "bg-amber-50/40 dark:bg-amber-950/10"
                          : ""
                    }
                  >
                    <TableCell>
                      <JobHealthBadge job={job} />
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-col">
                        <span className="font-medium">{job.displayName}</span>
                        <span className="text-xs text-muted-foreground flex items-center gap-1.5">
                          {job.category}
                          <span className="opacity-50">·</span>
                          {typeLabel(job.type)}
                        </span>
                        {job.message && (
                          <span
                            className="text-xs text-destructive/90 max-w-[420px] truncate cursor-help mt-0.5"
                            title={job.message}
                          >
                            {job.message}
                          </span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-col">
                        <span className="text-sm flex items-center gap-1.5">
                          <CalendarClock className="h-3 w-3 text-muted-foreground" />
                          {job.scheduleHuman || "–"}
                        </span>
                        {job.schedulerState && job.schedulerState !== "ENABLED" && (
                          <span className="text-[10px] text-amber-600 dark:text-amber-400">{job.schedulerState}</span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-col">
                        <span className="text-sm" title={job.lastRunAt}>
                          {relative(job.lastRunAt)}
                        </span>
                        {job.lastSuccessAt && job.health !== "ok" && (
                          <span className="text-[10px] text-muted-foreground" title={job.lastSuccessAt}>
                            last ok {relative(job.lastSuccessAt)}
                          </span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-sm">
                      {duration(job.durationSeconds)}
                    </TableCell>
                    <TableCell>
                      {job.logUri ? (
                        <a
                          href={job.logUri}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-muted-foreground hover:text-foreground"
                          title="View logs in Cloud Console"
                        >
                          <ExternalLink className="h-4 w-4" />
                        </a>
                      ) : (
                        <span className="text-muted-foreground/30">–</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
                {jobs.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center text-muted-foreground h-24">
                      No scheduled jobs found.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </>
        )}
      </CardContent>
    </Card>
  );
}
