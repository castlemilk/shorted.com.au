"use client";

/**
 * "Validate sync" — the per-stock, read-only proof that the ASIC pipeline works.
 *
 * An operator types stock codes, presses Validate, and gets back: what the
 * latest ASIC file(s) contain for those codes, what the sync would insert or
 * update, and how that compares with the database right now. Nothing is
 * written: the backend always runs the job in `-shadow` mode.
 *
 * The panel owns only the polling loop and the rendering. Every safety decision
 * (which job, which arguments, which codes are legal) lives server-side.
 */

import { MAX_VALIDATE_DAYS } from "~/app/actions/validate-sync-limits";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  getSyncValidation,
  normalizeStockInput,
  startSyncValidation,
  type ShadowSummary,
  type StockObservation,
  type StockValues,
} from "~/app/actions/validateSync";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { AlertTriangle, ExternalLink, Loader2, ShieldCheck } from "lucide-react";

/** How often the report is polled once a run has been accepted. */
const POLL_INTERVAL_MS = 10_000;
/**
 * Stop polling after 10 minutes. A shadow run over a week of ASIC files takes
 * well under a minute; an unbounded poll is just a leak.
 */
const POLL_TIMEOUT_MS = 10 * 60_000;

type Phase =
  | { kind: "idle" }
  | { kind: "starting" }
  | { kind: "polling"; execution: string; since: number }
  | { kind: "done"; execution: string; summary: ShadowSummary; logUri?: string }
  | { kind: "failed"; message: string; logTail?: string[]; logUri?: string };

function StatusBadge({ status }: { status: StockObservation["status"] }) {
  switch (status) {
    case "new":
      return (
        <Badge
          variant="secondary"
          className="bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-400"
        >
          new
        </Badge>
      );
    case "changed":
      return (
        <Badge
          variant="secondary"
          className="bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400"
        >
          changed
        </Badge>
      );
    case "missing-from-file":
      return (
        <Badge
          variant="secondary"
          className="bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-400"
        >
          missing from file
        </Badge>
      );
    default:
      return (
        <Badge variant="outline" className="text-muted-foreground">
          unchanged
        </Badge>
      );
  }
}

const nf = new Intl.NumberFormat("en-AU");

function valueCell(v: StockValues | undefined) {
  if (!v) return <span className="text-muted-foreground/40">–</span>;
  return (
    <div className="flex flex-col tabular-nums leading-tight">
      <span>{nf.format(Math.round(v.reported_short_positions))}</span>
      <span className="text-[10px] text-muted-foreground">
        {v.percent.toFixed(2)}% of {nf.format(Math.round(v.total_product_in_issue))}
      </span>
    </div>
  );
}

/** Matches the job's `-validate-days` default. */
const DEFAULT_VALIDATE_DAYS = 7;

export function SyncValidationPanel() {
  const [raw, setRaw] = useState("");
  const [days, setDays] = useState(String(DEFAULT_VALIDATE_DAYS));
  const [inputError, setInputError] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  // Kept in a ref so the polling effect never re-subscribes on every tick.
  const phaseRef = useRef(phase);
  phaseRef.current = phase;

  const start = useCallback(async () => {
    const { codes, error } = await normalizeStockInput(raw);
    if (error) {
      setInputError(error);
      return;
    }
    const windowDays = Number.parseInt(days, 10);
    if (!Number.isInteger(windowDays) || windowDays < 1 || windowDays > MAX_VALIDATE_DAYS) {
      setInputError(`Days must be a whole number from 1 to ${MAX_VALIDATE_DAYS}`);
      return;
    }
    setInputError(null);
    setPhase({ kind: "starting" });

    const res = await startSyncValidation({ stocks: codes, days: windowDays });
    if (!res.ok || !res.executionName) {
      setPhase({ kind: "failed", message: res.message });
      return;
    }
    setPhase({ kind: "polling", execution: res.executionName, since: Date.now() });
  }, [raw, days]);

  // The effect keys on the execution being polled, not on `phase` — a phase
  // object is recreated on every render, and re-subscribing the interval each
  // time would poll far faster than intended.
  const pollExecution = phase.kind === "polling" ? phase.execution : null;

  useEffect(() => {
    if (!pollExecution) return;
    let cancelled = false;

    const tick = async () => {
      const current = phaseRef.current;
      if (cancelled || current.kind !== "polling") return;
      if (Date.now() - current.since > POLL_TIMEOUT_MS) {
        setPhase({
          kind: "failed",
          message: `Gave up waiting for ${current.execution} after 10 minutes. The run may still be going — check the logs.`,
        });
        return;
      }

      const rep = await getSyncValidation(current.execution);
      if (cancelled) return;

      if (!rep.ok) {
        setPhase({
          kind: "failed",
          message: rep.message ?? "Could not read the validation result",
          logTail: rep.logTail,
          logUri: rep.logUri,
        });
        return;
      }
      if (rep.status === "running") return; // keep polling
      if (rep.status === "failed" || !rep.summary) {
        setPhase({
          kind: "failed",
          message: rep.message ?? "The validation run failed",
          logTail: rep.logTail,
          logUri: rep.logUri,
        });
        return;
      }
      setPhase({
        kind: "done",
        execution: current.execution,
        summary: rep.summary,
        logUri: rep.logUri,
      });
    };

    // Poll immediately, then on the interval — a shadow run can finish inside
    // the first tick, and waiting 10s to notice reads as a hang.
    void tick();
    const id = setInterval(() => void tick(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [pollExecution]);

  const busy = phase.kind === "starting" || phase.kind === "polling";

  return (
    <div className="rounded-lg border bg-muted/20 p-4 space-y-3">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h3 className="flex items-center gap-2 text-sm font-medium">
            <ShieldCheck className="h-4 w-4" />
            Validate sync for specific stocks
          </h3>
          <p className="text-xs text-muted-foreground">
            Runs <span className="font-mono">shorts-data-sync</span> in shadow mode — it downloads
            and parses the ASIC files exactly as a real run does, then reports what it WOULD write
            for these codes against what is in the database. Nothing is written. It re-reads the
            last N <em>published</em> ASIC dates regardless of what is already ingested, so{" "}
            <span className="font-medium">unchanged on every row is the pass</span>: the file and
            the database agree.
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-start gap-2">
        <div className="flex flex-col gap-1">
          <Input
            value={raw}
            onChange={(e) => {
              setRaw(e.target.value);
              setInputError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !busy) void start();
            }}
            placeholder="BHP, DRO, CBA"
            className="h-8 w-[280px] font-mono text-xs uppercase"
            aria-label="Stock codes to validate"
            disabled={busy}
          />
          {inputError && <span className="text-[11px] text-red-600">{inputError}</span>}
        </div>
        <div className="flex items-center gap-1.5">
          <Input
            value={days}
            onChange={(e) => {
              setDays(e.target.value);
              setInputError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !busy) void start();
            }}
            type="number"
            min={1}
            max={MAX_VALIDATE_DAYS}
            className="h-8 w-[64px] text-xs tabular-nums"
            aria-label={`ASIC dates to re-read (1-${MAX_VALIDATE_DAYS})`}
            disabled={busy}
          />
          <span className="text-[11px] text-muted-foreground">ASIC dates</span>
        </div>
        <Button size="sm" className="h-8 gap-1.5" disabled={busy} onClick={() => void start()}>
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          {phase.kind === "starting"
            ? "Starting…"
            : phase.kind === "polling"
              ? "Running…"
              : "Validate"}
        </Button>
      </div>

      {phase.kind === "polling" && (
        <p className="text-xs text-muted-foreground">
          Execution <span className="font-mono">{phase.execution}</span> in flight — polling every{" "}
          {POLL_INTERVAL_MS / 1000}s.
        </p>
      )}

      {phase.kind === "failed" && (
        <div className="space-y-2 rounded border border-red-300/60 bg-red-50/60 p-3 dark:border-red-900/50 dark:bg-red-950/20">
          <div className="flex items-start gap-2 text-xs text-red-700 dark:text-red-400">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{phase.message}</span>
          </div>
          {phase.logTail && phase.logTail.length > 0 && (
            <pre className="max-h-40 overflow-auto rounded bg-background/70 p-2 text-[10px] leading-relaxed">
              {phase.logTail.join("\n")}
            </pre>
          )}
          {phase.logUri && (
            <a
              href={phase.logUri}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
            >
              Open logs in Cloud Console <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </div>
      )}

      {phase.kind === "done" && <ValidationReportView phase={phase} />}
    </div>
  );
}

function ValidationReportView({
  phase,
}: {
  phase: Extract<Phase, { kind: "done" }>;
}) {
  const { summary, logUri, execution } = phase;
  const stocks = summary.stocks;
  const win = summary.validation;
  // The one genuinely broken outcome: no files at all. It must be told apart
  // from "the code was absent from the files", so it is checked FIRST and the
  // not-found banner is suppressed under it (with no files, not_found is
  // vacuous).
  const windowEmpty = stocks?.window_empty ?? summary.files_selected === 0;
  const observations = stocks?.observations ?? [];
  const allUnchanged =
    observations.length > 0 && observations.every((o) => o.status === "unchanged");

  return (
    <div className="space-y-3">
      {win && (
        <p className="text-[11px] text-muted-foreground">
          Window: last <span className="font-medium text-foreground">{win.days}</span> published
          ASIC date(s)
          {win.from && win.to ? (
            <>
              {" "}
              (<span className="tabular-nums">{win.from}</span> →{" "}
              <span className="tabular-nums">{win.to}</span>)
            </>
          ) : null}
          {win.ignored_cutoff && (
            <> — a real sync would start at {win.ignored_cutoff}; validation ignores that.</>
          )}
        </p>
      )}

      {windowEmpty && (
        <div className="flex items-start gap-2 rounded border border-red-300/60 bg-red-50/60 p-2 text-[11px] text-red-700 dark:border-red-900/50 dark:bg-red-950/20 dark:text-red-400">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            {win?.problem ??
              "No ASIC files were scanned, so this report says nothing about these codes."}{" "}
            This is a problem with the run, not with the stocks.
          </span>
        </div>
      )}

      {allUnchanged && (
        <div className="flex items-start gap-2 rounded border border-emerald-300/60 bg-emerald-50/60 p-2 text-[11px] text-emerald-800 dark:border-emerald-900/50 dark:bg-emerald-950/20 dark:text-emerald-400">
          <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            Every row matches: the ASIC files and the database agree on all{" "}
            {observations.length} observation(s). The pipeline is working for these codes.
          </span>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground tabular-nums">
        <span>
          <span className="font-medium text-foreground">{summary.files_parsed}</span>/
          {summary.files_selected} files parsed
        </span>
        <span>
          <span className="font-medium text-foreground">{nf.format(summary.rows_parsed)}</span> rows
          parsed
        </span>
        <span>
          would insert{" "}
          <span className="font-medium text-foreground">{nf.format(summary.would_insert)}</span>
        </span>
        <span>
          would update{" "}
          <span className="font-medium text-foreground">{nf.format(summary.would_update)}</span>
        </span>
        {summary.last_shorts_date && <span>last DB date {summary.last_shorts_date}</span>}
        {summary.already_up_to_date && (
          <Badge variant="outline" className="h-5 text-[10px]">
            already up to date
          </Badge>
        )}
      </div>

      {summary.files_failed && summary.files_failed.length > 0 && (
        <div className="rounded border border-amber-300/60 bg-amber-50/60 p-2 text-[11px] text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/20 dark:text-amber-400">
          {summary.files_failed.length} file(s) could not be downloaded or parsed:{" "}
          {summary.files_failed.map((f) => f.file).join(", ")}
        </div>
      )}

      {stocks && !windowEmpty && stocks.not_found.length > 0 && (
        <div className="rounded border border-orange-300/60 bg-orange-50/60 p-2 text-[11px] text-orange-800 dark:border-orange-900/50 dark:bg-orange-950/20 dark:text-orange-400">
          Not present in any parsed file: <span className="font-mono">{stocks.not_found.join(", ")}</span>
          . ASIC omits a stock with no reportable short position, so this is not necessarily an
          error.
        </div>
      )}

      {observations.length > 0 ? (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[70px]">Code</TableHead>
              <TableHead className="w-[100px]">Date</TableHead>
              <TableHead>ASIC file</TableHead>
              <TableHead>Database now</TableHead>
              <TableHead className="w-[150px]">Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {observations.map((o) => (
              <TableRow key={`${o.code}-${o.date}`}>
                <TableCell className="font-mono text-xs font-medium">{o.code}</TableCell>
                <TableCell className="text-xs tabular-nums">{o.date}</TableCell>
                <TableCell className="text-xs">{valueCell(o.file_values)}</TableCell>
                <TableCell className="text-xs">{valueCell(o.db_values)}</TableCell>
                <TableCell>
                  <div className="flex flex-col gap-0.5">
                    <StatusBadge status={o.status} />
                    {o.changed_fields && o.changed_fields.length > 0 && (
                      <span className="text-[10px] text-muted-foreground">
                        {o.changed_fields.join(", ")}
                      </span>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : (
        <p className="text-xs text-muted-foreground">
          {windowEmpty
            ? "No ASIC files were scanned, so there is nothing to compare."
            : "These codes appear in none of the ASIC files in this window, and the database holds no rows for them either."}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
        <span className="font-mono">{execution}</span>
        <RawJsonLink summary={summary} />
        {logUri && (
          <a
            href={logUri}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 hover:text-foreground"
          >
            Cloud Console logs <ExternalLink className="h-3 w-3" />
          </a>
        )}
      </div>
    </div>
  );
}

/**
 * The raw summary, behind a click. It is the actual artefact — everything above
 * is a rendering of it — but it is also a wall of JSON, so it stays collapsed.
 */
function RawJsonLink({ summary }: { summary: ShadowSummary }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="underline underline-offset-2 hover:text-foreground"
        onClick={() => setOpen((v) => !v)}
      >
        {open ? "Hide" : "Show"} raw JSON (schema v{summary.schema_version})
      </button>
      {open && (
        <pre className="mt-2 max-h-72 w-full overflow-auto rounded bg-background/70 p-2 text-[10px] leading-relaxed">
          {JSON.stringify(summary, null, 2)}
        </pre>
      )}
    </>
  );
}
