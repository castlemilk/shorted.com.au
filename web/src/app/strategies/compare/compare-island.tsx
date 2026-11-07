"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useSession } from "next-auth/react";
import { useEffect, useState } from "react";

import { buttonVariants } from "~/@/components/ui/button";
import { compareGeometry } from "~/@/lib/strategies/compare-geometry";
import {
  COMPARE_LIMIT,
  COMPARE_MINIMUM,
  EXPLORER_COPY,
  compareCandidates,
  compareHref,
} from "~/@/lib/strategies/explorer";
import { formatIsoDate, NOT_AVAILABLE, formatSigned } from "~/@/lib/strategies/format";
import type {
  CompareEntryView,
  CompareStrategiesView,
  WindowMetricsView,
} from "~/@/lib/strategies/map-backtest";
import {
  compareStrategiesForViewer,
  type CompareFailure,
  type CompareResult,
} from "~/app/actions/strategies/compare";
import { cn } from "~/@/lib/utils";

const ID = /^[a-z0-9-]{1,64}$/;
const CHART = { width: 640, height: 240 } as const;
/** Strokes in order: the strategies (primary, ink, muted), then XJT dashed. Never a market colour. */
const STROKES = ["hsl(var(--primary))", "hsl(var(--foreground) / 0.7)", "hsl(var(--muted-foreground))"];
const XJT_STROKE = "hsl(var(--muted-foreground))";
const AUD_100K = 100000;

/** The ids the URL names: valid, unique, at most the limit. Unknown ids are kept so they can be named. */
export function parseCompareIds(raw: string | null): string[] {
  const out: string[] = [];
  for (const part of (raw ?? "").split(",")) {
    const id = part.trim();
    if (ID.test(id) && !out.includes(id)) out.push(id);
    if (out.length === COMPARE_LIMIT) break;
  }
  return out;
}

type Load =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; comparison: CompareStrategiesView; survivorship: Record<string, string> }
  | { kind: "failed"; reason: CompareFailure };

/** The address for a picked set: the ids joined with commas, or the bare page when none is picked. */
function addressFor(ids: readonly string[]): string {
  return ids.length ? `${window.location.pathname}?ids=${ids.map(encodeURIComponent).join(",")}` : window.location.pathname;
}

/**
 * The compare page's island. The picker offers the registry's strategies with the URL's ids
 * ticked; at two picks the comparison loads, for a signed-in visitor through the signed-in
 * action. An anonymous visitor gets the same picker and the sign-in prompt, which carries the
 * chosen ids. A failure names its cause: a permanent one says so, and a transient one offers a
 * retry. The comparison is per viewer, so nothing here is cached.
 */
export function CompareIsland() {
  const params = useSearchParams();
  const { data: session, status } = useSession();
  const signedIn = status === "authenticated" && !!session?.user?.id;
  const [picked, setPicked] = useState<string[]>(() => parseCompareIds(params.get("ids")));
  const [attempt, setAttempt] = useState(0);
  const [load, setLoad] = useState<Load>({ kind: "idle" });

  const known = new Set(compareCandidates().map((c) => c.id));
  const unknown = picked.filter((id) => !known.has(id));
  const key = picked.join(",");

  useEffect(() => {
    if (status !== "authenticated" || picked.length < COMPARE_MINIMUM || unknown.length > 0) return;
    let live = true;
    setLoad({ kind: "loading" });
    compareStrategiesForViewer(picked)
      .then((result: CompareResult) => {
        if (!live) return;
        if (result.ok) setLoad({ kind: "ready", comparison: result.comparison, survivorship: result.survivorship });
        else setLoad({ kind: "failed", reason: result.reason });
      })
      .catch(() => {
        // The action catches its own failures; a rejection that gets past it is still a
        // transient failure, and the page must not wait on it.
        if (live) setLoad({ kind: "failed", reason: "unavailable" });
      });
    return () => {
      live = false;
    };
    // The id set is the request: `key` stands for `picked`, and the retry counter re-reads it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, key, attempt]);

  const toggle = (id: string) => {
    const next = picked.includes(id)
      ? picked.filter((x) => x !== id)
      : picked.length >= COMPARE_LIMIT
        ? picked
        : [...picked, id];
    setPicked(next);
    try {
      window.history.replaceState(null, "", addressFor(next));
    } catch {
      // A blocked history write leaves the picker in place; only the address is stale.
    }
  };

  const picker = (
    <fieldset className="space-y-3 rounded-lg border border-border p-4">
      <legend className="px-1 text-sm font-semibold">Add a strategy</legend>
      <p className="text-xs text-muted-foreground">Choose two or three. The comparison opens at two.</p>
      <ul className="grid gap-2 sm:grid-cols-2">
        {compareCandidates().map((c) => {
          const isPicked = picked.includes(c.id);
          const full = picked.length >= COMPARE_LIMIT && !isPicked;
          return (
            <li key={c.id}>
              <label className={cn("flex items-center gap-2 text-sm", full && "text-muted-foreground")}>
                <input
                  type="checkbox"
                  checked={isPicked}
                  disabled={full}
                  onChange={() => toggle(c.id)}
                  className="h-4 w-4 accent-[hsl(var(--primary))]"
                />
                {c.name}
              </label>
            </li>
          );
        })}
      </ul>
      {unknown.length > 0 ? (
        <p className="text-sm text-muted-foreground">
          Not a strategy we publish: {unknown.join(", ")}. Remove it to compare the others.
        </p>
      ) : null}
    </fieldset>
  );

  if (status === "loading") {
    return (
      <div role="status" aria-busy="true" aria-label="Loading your comparison" className="text-sm text-muted-foreground">
        Loading your comparison…
      </div>
    );
  }

  if (!signedIn) {
    return (
      <div className="space-y-4">
        {picker}
        <section className="rounded-lg border border-border p-5">
          <h2 className="text-base font-semibold">Sign in to compare</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Comparing strategies is free for a signed-in reader. Sign in and this comparison opens as you left it.
          </p>
          <Link
            href={`/signin?callbackUrl=${encodeURIComponent(compareHref(picked))}`}
            prefetch={false}
            className={cn(buttonVariants({ variant: "default" }), "mt-3")}
          >
            Sign in to compare
          </Link>
        </section>
      </div>
    );
  }

  if (picked.length < COMPARE_MINIMUM) {
    return (
      <div className="space-y-4">
        {picker}
        <p className="text-sm text-muted-foreground">Pick one more strategy to see the comparison.</p>
      </div>
    );
  }

  if (unknown.length > 0) {
    return <div className="space-y-4">{picker}</div>;
  }

  if (load.kind === "idle" || load.kind === "loading") {
    return (
      <div className="space-y-4">
        {picker}
        <div role="status" aria-busy="true" aria-label="Loading the comparison" className="text-sm text-muted-foreground">
          Loading the comparison…
        </div>
      </div>
    );
  }

  if (load.kind === "failed") {
    return (
      <div className="space-y-4">
        {picker}
        <FailureNote reason={load.reason} onRetry={() => setAttempt((n) => n + 1)} />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {picker}
      <Comparison comparison={load.comparison} survivorship={load.survivorship} />
    </div>
  );
}

/** Each failure's own words. A permanent one says it will not change; a transient one offers a retry. */
function FailureNote({ reason, onRetry }: { reason: CompareFailure; onRetry: () => void }) {
  switch (reason) {
    case "invalid":
      return <p className="text-sm text-muted-foreground">Choose two or three different strategies to compare.</p>;
    case "not-found":
      return (
        <p className="text-sm text-muted-foreground">
          One of these strategies has no published record, so it cannot be compared. Remove it and compare the others.
        </p>
      );
    case "signed-out":
      return (
        <p className="text-sm text-muted-foreground">
          Your session is not accepted for this comparison. Sign in again to compare.
        </p>
      );
    default:
      return (
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">The comparison is unavailable right now.</p>
          <button
            type="button"
            onClick={onRetry}
            className="rounded-sm border border-border px-3 py-1.5 text-sm hover:border-primary"
          >
            Try again
          </button>
        </div>
      );
  }
}

/** The comparison's curves on one scale: each strategy, and XJT rebased to the same start. */
function curvesOf(comparison: CompareStrategiesView) {
  const strategies = comparison.entries.map((entry) => ({
    key: entry.strategyRef,
    points: entry.series.map((p) => ({ t: p.t, v: p.equity })),
  }));
  // XJT rides on the strategies' own series: its index level, rebased to the same A$100,000 start.
  const first = comparison.entries.find((e) => e.series.some((p) => p.benchmark !== null));
  const bench = first?.series.filter((p) => p.benchmark !== null) ?? [];
  const base = bench[0]?.benchmark ?? 0;
  const xjt =
    base > 0
      ? { key: "xjt", points: bench.map((p) => ({ t: p.t, v: (p.benchmark! / base) * AUD_100K })) }
      : null;
  return { strategies, xjt };
}

function aud(value: number): string {
  return `A$${Math.round(value).toLocaleString("en-AU")}`;
}

/** A window's return line: CAGR when it is annualised, the total marked otherwise. */
function returnText(window: WindowMetricsView | null): { text: string; note?: string } {
  if (!window) return { text: NOT_AVAILABLE };
  if (window.cagrPct !== null) return { text: `${formatSigned(window.cagrPct)} a year` };
  if (window.totalReturnPct !== null) {
    return { text: `${formatSigned(window.totalReturnPct)} total`, note: "not annualised" };
  }
  return { text: NOT_AVAILABLE };
}

function Comparison({ comparison, survivorship }: { comparison: CompareStrategiesView; survivorship: Record<string, string> }) {
  const { strategies, xjt } = curvesOf(comparison);
  const curves = xjt ? [...strategies, xjt] : strategies;
  const geometry = compareGeometry(curves, CHART.width, CHART.height);
  const named = (ref: string) => comparison.entries.find((e) => e.strategyRef === ref)?.name ?? ref;
  const endOf = (points: readonly { v: number | null }[]) => {
    const finite = points.filter((p): p is { v: number } => p.v !== null && Number.isFinite(p.v));
    return finite.length ? finite[finite.length - 1]!.v : null;
  };
  const ends = curves.map((c, index) => ({
    key: c.key,
    label: c.key === "xjt" ? "S&P/ASX 200 Gross TR (XJT)" : named(c.key),
    value: endOf(c.points),
    stroke: c.key === "xjt" ? XJT_STROKE : STROKES[index] ?? STROKES[0],
  }));
  const hasCurves = geometry.paths.some((p) => p.d);

  return (
    <div className="space-y-6">
      <p className="font-mono text-xs text-muted-foreground">
        {comparison.windowFrom && comparison.windowTo
          ? `Common window: ${formatIsoDate(comparison.windowFrom)} to ${formatIsoDate(comparison.windowTo)}`
          : "No common window: at least one strategy has no published run."}
      </p>

      <section aria-labelledby="compare-curves" className="space-y-3">
        <h2 id="compare-curves" className="text-base font-semibold">
          Growth of A$100,000, after costs
        </h2>
        {hasCurves ? (
          <figure className="space-y-2">
            <div className="grid grid-cols-[auto_1fr] gap-x-2">
              <div className="flex flex-col justify-between py-1 text-right font-mono text-[10px] text-muted-foreground">
                <span>{geometry.yMax !== null ? aud(geometry.yMax) : ""}</span>
                <span>{geometry.yMin !== null ? aud(geometry.yMin) : ""}</span>
              </div>
              <svg
                role="img"
                aria-label="Growth of A$100,000 over the common window, one line per strategy and XJT, on one scale"
                viewBox={`0 0 ${CHART.width} ${CHART.height}`}
                preserveAspectRatio="none"
                className="block h-60 w-full overflow-visible"
              >
                {geometry.paths.map((path) => {
                  const end = ends.find((e) => e.key === path.key);
                  return path.d ? (
                    <path
                      key={path.key}
                      data-curve={path.key}
                      d={path.d}
                      fill="none"
                      stroke={end?.stroke}
                      strokeWidth={path.key === "xjt" ? 1.25 : 1.75}
                      strokeLinejoin="round"
                      strokeDasharray={path.key === "xjt" ? "4 3" : undefined}
                      vectorEffect="non-scaling-stroke"
                    />
                  ) : null;
                })}
              </svg>
            </div>
            <div className="flex justify-between pl-10 font-mono text-[10px] text-muted-foreground">
              <span>{formatIsoDate(comparison.windowFrom)}</span>
              <span>{formatIsoDate(comparison.windowTo)}</span>
            </div>
            <ul className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11px] text-muted-foreground">
              {ends.map((e) => (
                <li key={e.key}>
                  <span aria-hidden="true" style={{ color: e.stroke }}>
                    ■
                  </span>{" "}
                  {e.label}
                  {e.value !== null ? `: ${aud(e.value)} at the end` : ""}
                </li>
              ))}
            </ul>
          </figure>
        ) : (
          <p className="text-sm text-muted-foreground">No published curve covers this window yet.</p>
        )}
        <p className="font-mono text-[11px] text-muted-foreground">{EXPLORER_COPY.costs}</p>
      </section>

      <section aria-labelledby="compare-table" className="space-y-3">
        <h2 id="compare-table" className="text-base font-semibold">
          Window figures
        </h2>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-xs">
            <caption className="sr-only">Each strategy&apos;s return, drawdown, trades and Sharpe over the common window</caption>
            <thead>
              <tr className="text-left font-mono font-normal text-muted-foreground">
                <th scope="col" className="px-2 py-1 font-normal">Strategy</th>
                <th scope="col" className="px-2 py-1 text-right font-normal">Return</th>
                <th scope="col" className="px-2 py-1 text-right font-normal">Max DD</th>
                <th scope="col" className="px-2 py-1 text-right font-normal">Closed trades</th>
                <th scope="col" className="px-2 py-1 text-right font-normal">Sharpe</th>
              </tr>
            </thead>
            <tbody>
              {comparison.entries.map((entry) => (
                <CompareRow key={entry.strategyRef} entry={entry} survivorship={survivorship[entry.strategyId] ?? ""} />
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {comparison.correlations.length > 0 ? (
        <section aria-labelledby="compare-corr" className="space-y-2">
          <h2 id="compare-corr" className="text-base font-semibold">
            Daily returns, correlation
          </h2>
          <ul className="space-y-1 text-sm">
            {comparison.correlations.map((pair) => (
              <li key={`${pair.a}-${pair.b}`}>
                {named(pair.a)} with {named(pair.b)}:{" "}
                {pair.correlation === null
                  ? "too few shared days to measure"
                  : `${pair.correlation.toFixed(2)} over ${pair.days} days`}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {comparison.ruleDiffs.length > 0 ? (
        <section aria-labelledby="compare-diff" className="space-y-2">
          <h2 id="compare-diff" className="text-base font-semibold">
            Where the rules differ
          </h2>
          <ul className="space-y-1 text-sm">
            {comparison.ruleDiffs.map((d) => (
              <li key={`${d.a}-${d.b}-${d.field}`}>
                {d.field}: {named(d.a)} {d.aValue}, {named(d.b)} {d.bValue}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <p className="text-xs text-muted-foreground">{EXPLORER_COPY.hypothetical}</p>
    </div>
  );
}

function CompareRow({ entry, survivorship }: { entry: CompareEntryView; survivorship: string }) {
  const ret = returnText(entry.window);
  const dd = entry.window?.maxDrawdownPct;
  const sharpe = entry.window?.sharpe;
  const se = entry.window?.sharpeSe;
  // The mapper nulls Sharpe unless the API set its flag (fewer than 126 daily returns: n/m).
  const hasSharpe = sharpe != null;
  return (
    <tr className="border-t border-border/60 align-top">
      <th scope="row" className="px-2 py-1.5 text-left font-normal">
        {entry.name}
        {entry.window ? (
          <span className="block font-mono text-[10px] text-muted-foreground">
            {entry.window.note || entry.window.label}
          </span>
        ) : (
          <span className="block font-mono text-[10px] text-muted-foreground">
            {entry.stateReason || "No published run"}
          </span>
        )}
        {survivorship ? (
          <span className="block max-w-prose text-[10px] leading-snug text-muted-foreground">{survivorship}</span>
        ) : null}
      </th>
      <td className="px-2 py-1.5 text-right tabular-nums">
        {ret.text}
        {ret.note ? <span className="block font-mono text-[10px] text-muted-foreground">{ret.note}</span> : null}
      </td>
      <td className="px-2 py-1.5 text-right tabular-nums" style={dd != null && dd < 0 ? { color: "var(--semantic-red-text)" } : undefined}>
        {dd != null ? formatSigned(dd) : NOT_AVAILABLE}
      </td>
      <td className="px-2 py-1.5 text-right tabular-nums">{entry.window ? entry.window.closedTrades : NOT_AVAILABLE}</td>
      <td className="px-2 py-1.5 text-right tabular-nums">
        {hasSharpe ? `${sharpe.toFixed(2)}${se != null ? ` (± ${se.toFixed(2)})` : ""}` : NOT_AVAILABLE}
      </td>
    </tr>
  );
}
