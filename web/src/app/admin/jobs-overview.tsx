"use client";

import { useState } from "react";
import type { JobsOverview as JobsOverviewData, JobStatus } from "~/app/actions/getJobsOverview";
import { runJobNow, type RunJobResult } from "~/app/actions/runJob";
import { SyncValidationPanel } from "./sync-validation";
import { Button } from "@/components/ui/button";
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
  CalendarX,
  Archive,
  Play,
  Loader2,
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

// coarseDuration renders "3d" / "5h" / "12m" for the overdue-by delta.
function coarseDuration(seconds: number): string {
  if (!seconds || seconds <= 0) return "";
  if (seconds >= 48 * 3600) return `${Math.floor(seconds / 86400)}d`;
  if (seconds >= 3600) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.max(1, Math.floor(seconds / 60))}m`;
}

function statusLabel(job: JobStatus): string {
  switch (job.health) {
    case "critical":
      // A rig that has gone silent past the dead-rig horizon is "offline", not "failed".
      if (job.type === "rig" && job.lastRunStatus !== "failed") return "offline";
      return "failed";
    case "running":
      return "running";
    case "overdue": {
      // The run that DID happen worked; the problem is the one that didn't.
      const by = coarseDuration(job.overdueBySeconds ?? 0);
      return by ? `overdue ${by}` : "overdue";
    }
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
    case "overdue":
      return (
        <Badge
          variant="secondary"
          className="gap-1 bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-400"
        >
          <CalendarX className="h-3 w-3" />
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
  tone: "ok" | "critical" | "overdue" | "warning" | "muted";
}) {
  const toneClass =
    tone === "critical"
      ? "text-red-700 dark:text-red-400"
      : tone === "overdue"
        ? "text-orange-600 dark:text-orange-400"
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

// HEALTH_RANK mirrors jobmonitor.healthRank so the table reads problems-first.
// The frontend must sort too: the backend sorts the GCP fleet, then APPENDS the
// rig rows, so an offline rig would otherwise sit below every healthy job.
const HEALTH_RANK: Record<JobStatus["health"], number> = {
  critical: 0,
  overdue: 1,
  warning: 2,
  running: 3,
  unknown: 4,
  ok: 5,
};

function byProblemsFirst(a: JobStatus, b: JobStatus): number {
  // Retired jobs are deployed-but-unscheduled by design — always last.
  if (Boolean(a.retired) !== Boolean(b.retired)) return a.retired ? 1 : -1;
  const rank = HEALTH_RANK[a.health] - HEALTH_RANK[b.health];
  if (rank !== 0) return rank;
  return a.displayName.localeCompare(b.displayName);
}

/**
 * Per-job run state. `started` survives a re-render so the row keeps reading
 * "running" after an optimistic flip, and `blocked` is set ONLY by a 409
 * already-running response — which is what unlocks the force option. Force is
 * never offered up front: the guard exists precisely so a parallel run is a
 * second, deliberate decision.
 */
type RunState =
  | { phase: "idle" }
  | { phase: "busy" }
  | { phase: "started"; executionName?: string }
  | { phase: "blocked"; message: string; forceable: boolean }
  | { phase: "error"; message: string };

function RunNowButton({
  job,
  state,
  onState,
}: {
  job: JobStatus;
  state: RunState;
  onState: (s: RunState) => void;
}) {
  // Only Cloud Run Jobs are executable: scheduler-only "service" rows and the
  // residential rig have nothing to run, and retired jobs are refused backend-side.
  if (job.type !== "job" || job.retired) {
    return <span className="text-muted-foreground/30">–</span>;
  }

  async function run(force: boolean) {
    const confirmed = force
      ? window.confirm(
          `${job.displayName} already has a run in flight.\n\nStart a SECOND, parallel execution anyway?`,
        )
      : window.confirm(`Run ${job.displayName} now?`);
    if (!confirmed) return;

    onState({ phase: "busy" });
    const res: RunJobResult = await runJobNow({
      job: job.name,
      region: job.region,
      force,
    });

    if (res.ok) {
      onState({ phase: "started", executionName: res.executionName });
      return;
    }
    if (res.code === "already_running" && res.forceable) {
      onState({ phase: "blocked", message: res.message, forceable: true });
      return;
    }
    onState({ phase: "error", message: res.message });
  }

  if (state.phase === "started") {
    return (
      <span
        className="text-[10px] text-emerald-600 dark:text-emerald-400"
        title={state.executionName}
      >
        started
      </span>
    );
  }

  return (
    <Button
      size="sm"
      variant="outline"
      className="h-7 gap-1 px-2 text-xs"
      disabled={state.phase === "busy"}
      onClick={() => void run(state.phase === "blocked" && state.forceable)}
      title={
        state.phase === "blocked"
          ? `${state.message} — run anyway (force)`
          : `Execute ${job.name} now`
      }
    >
      {state.phase === "busy" ? (
        <Loader2 className="h-3 w-3 animate-spin" />
      ) : (
        <Play className="h-3 w-3" />
      )}
      {state.phase === "blocked" ? "Force" : "Run"}
    </Button>
  );
}

export function JobsOverview({ overview }: { overview: JobsOverviewData }) {
  const [runStates, setRunStates] = useState<Record<string, RunState>>({});
  const setRunState = (name: string, s: RunState) =>
    setRunStates((prev) => ({ ...prev, [name]: s }));

  const { stale, errored } = overview;
  const jobs = [...overview.jobs].sort(byProblemsFirst);

  // Retired jobs are excluded from every alarm count: their steady state is
  // "paused", so counting them permanently pins the dashboard amber.
  const live = jobs.filter((j) => !j.retired);
  const counts = {
    total: live.length,
    ok: live.filter((j) => j.health === "ok").length,
    failing: live.filter((j) => j.health === "critical").length,
    overdue: live.filter((j) => j.health === "overdue").length,
    attention: live.filter((j) => j.health === "warning" || j.health === "running").length,
    unknown: live.filter((j) => j.health === "unknown").length,
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
              Every scheduled job across all Cloud Run regions + Cloud Scheduler, plus the
              residential crawl rigs. Sorted problems-first; &quot;overdue&quot; means the last run
              succeeded but the next one never fired.
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
            <div className="grid grid-cols-2 gap-3 md:grid-cols-6">
              <StatCard label="Live jobs" value={counts.total} tone="muted" />
              <StatCard label="Healthy" value={counts.ok} tone="ok" />
              <StatCard label="Failing" value={counts.failing} tone="critical" />
              <StatCard label="Overdue" value={counts.overdue} tone="overdue" />
              <StatCard label="Needs attention" value={counts.attention} tone="warning" />
              <StatCard label="No data" value={counts.unknown} tone="muted" />
            </div>

            {/* Per-stock sync validation. Rendered only when shorts-data-sync
                is actually in the fleet — the endpoint can execute that job and
                only that job, so without it the panel has nothing to drive. */}
            {jobs.some((j) => j.name === "shorts-data-sync" && j.type === "job" && !j.retired) && (
              <SyncValidationPanel />
            )}

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
                  <TableHead className="w-[80px] text-right">Run</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {jobs.map((job) => {
                  const runState: RunState = runStates[job.name] ?? { phase: "idle" };
                  // Optimistic flip: the moment a run is accepted the row reads
                  // "running", rather than showing the pre-run status until the
                  // next poll and inviting a second click.
                  const shown: JobStatus =
                    runState.phase === "started" || runState.phase === "busy"
                      ? { ...job, health: "running", lastRunStatus: "running", message: "" }
                      : job;
                  return (
                  <TableRow
                    key={job.name}
                    className={
                      job.retired
                        ? "opacity-55"
                        : job.health === "critical"
                          ? "bg-red-50/50 dark:bg-red-950/10"
                          : job.health === "overdue"
                            ? "bg-orange-50/50 dark:bg-orange-950/10"
                            : job.health === "warning"
                              ? "bg-amber-50/40 dark:bg-amber-950/10"
                              : ""
                    }
                  >
                    <TableCell>
                      <JobHealthBadge job={shown} />
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-col">
                        <span className="font-medium flex items-center gap-1.5">
                          {job.displayName}
                          {job.retired && (
                            <Badge variant="outline" className="gap-1 h-4 px-1 text-[9px] font-normal">
                              <Archive className="h-2.5 w-2.5" />
                              retired
                            </Badge>
                          )}
                        </span>
                        <span className="text-xs text-muted-foreground flex items-center gap-1.5">
                          {job.category}
                          <span className="opacity-50">·</span>
                          {typeLabel(job.type)}
                          {job.region && (
                            <>
                              <span className="opacity-50">·</span>
                              {job.region}
                            </>
                          )}
                        </span>
                        {job.note && (
                          <span
                            className="text-[10px] text-muted-foreground max-w-[420px] truncate cursor-help"
                            title={job.note}
                          >
                            {job.note}
                          </span>
                        )}
                        {job.records && job.records.length > 0 && (
                          <span className="text-[10px] text-muted-foreground tabular-nums mt-0.5">
                            {job.records
                              .map((r) => `${r.count.toLocaleString()} ${r.label}`)
                              .join(" · ")}
                          </span>
                        )}
                        {job.message && (
                          <span
                            className="text-xs text-destructive/90 max-w-[420px] truncate cursor-help mt-0.5"
                            title={job.message}
                          >
                            {job.message}
                          </span>
                        )}
                        {/* Run-now feedback, inline with the job it belongs to. */}
                        {runState.phase === "started" && (
                          <span className="text-[11px] text-emerald-600 dark:text-emerald-400 mt-0.5">
                            Execution started
                            {runState.executionName ? `: ${runState.executionName}` : ""}
                          </span>
                        )}
                        {runState.phase === "blocked" && (
                          <span className="text-[11px] text-amber-600 dark:text-amber-400 mt-0.5 max-w-[420px]">
                            {runState.message} — press Force to run a second, parallel execution.
                          </span>
                        )}
                        {runState.phase === "error" && (
                          <span
                            className="text-[11px] text-red-600 dark:text-red-400 mt-0.5 max-w-[420px] truncate cursor-help"
                            title={runState.message}
                          >
                            {runState.message}
                          </span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-col">
                        <span
                          className="text-sm flex items-center gap-1.5"
                          // Every trigger, so a five-schedule job (shorted-news)
                          // isn't misread as a single daily run.
                          title={(job.triggers ?? [])
                            .map(
                              (t) =>
                                `${t.name}: ${t.scheduleHuman}${t.state === "PAUSED" ? " (PAUSED)" : ""}`,
                            )
                            .join("\n")}
                        >
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
                    <TableCell className="text-right">
                      <RunNowButton
                        job={job}
                        state={runState}
                        onState={(s) => setRunState(job.name, s)}
                      />
                    </TableCell>
                  </TableRow>
                  );
                })}
                {jobs.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={7} className="text-center text-muted-foreground h-24">
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
