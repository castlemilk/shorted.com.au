"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useSession } from "next-auth/react";
import { useEffect, useState } from "react";

import { compareGeometry } from "~/@/lib/strategies/compare-geometry";
import { compareHref } from "~/@/lib/strategies/explorer";
import { formatIsoDate, NOT_AVAILABLE, formatSigned } from "~/@/lib/strategies/format";
import type {
  CompareEntryView,
  CompareStrategiesView,
  WindowMetricsView,
} from "~/@/lib/strategies/map-backtest";
import { compareStrategiesForViewer, type CompareResult } from "~/app/actions/strategies/compare";

const ID = /^[a-z0-9-]{1,64}$/;
const CHART = { width: 640, height: 240 } as const;
/** One stroke per compared strategy, in order: primary, ink, muted. Never a market colour. */
const STROKES = ["hsl(var(--primary))", "hsl(var(--foreground) / 0.7)", "hsl(var(--muted-foreground))"];

/** The ids the URL names: valid, unique, at most three. */
export function parseCompareIds(raw: string | null): string[] {
  const out: string[] = [];
  for (const part of (raw ?? "").split(",")) {
    const id = part.trim();
    if (ID.test(id) && !out.includes(id)) out.push(id);
    if (out.length === 3) break;
  }
  return out;
}

type Load =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; comparison: CompareStrategiesView }
  | { kind: "failed"; reason: "unavailable" | "invalid" };

/**
 * The compare page's island. An anonymous visitor gets the sign-in prompt and no
 * request; a signed-in visitor with two or three ids gets the comparison, read once
 * per id set through the signed-in action. The comparison is per viewer, so nothing
 * here is cached.
 */
export function CompareIsland() {
  const params = useSearchParams();
  const { data: session, status } = useSession();
  const ids = parseCompareIds(params.get("ids"));
  const signedIn = status === "authenticated" && !!session?.user?.id;
  const key = ids.join(",");

  const [load, setLoad] = useState<Load>({ kind: "idle" });

  useEffect(() => {
    if (status !== "authenticated" || ids.length < 2) return;
    let live = true;
    setLoad({ kind: "loading" });
    void compareStrategiesForViewer(ids).then((result: CompareResult) => {
      if (!live) return;
      if (result.ok) setLoad({ kind: "ready", comparison: result.comparison });
      else setLoad({ kind: "failed", reason: result.reason === "invalid" ? "invalid" : "unavailable" });
    });
    return () => {
      live = false;
    };
    // The id set is the request; `ids` is rebuilt each render, so the key stands for it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, key]);

  if (status === "loading") {
    return (
      <div role="status" aria-busy="true" aria-label="Loading your comparison" className="text-sm text-muted-foreground">
        Loading your comparison…
      </div>
    );
  }

  if (!signedIn) {
    const here = compareHref(ids);
    return (
      <section className="rounded-lg border border-border p-5">
        <h2 className="text-base font-semibold">Sign in to compare</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Comparing strategies is free for a signed-in reader. Sign in and this comparison opens as you left it.
        </p>
        <Link
          href={`/signin?callbackUrl=${encodeURIComponent(here)}`}
          prefetch={false}
          className="mt-3 inline-block text-sm font-medium text-foreground underline underline-offset-2 hover:no-underline"
        >
          Sign in
        </Link>
      </section>
    );
  }

  if (ids.length < 2) {
    return (
      <section className="rounded-lg border border-border p-5">
        <h2 className="text-base font-semibold">Choose two or three strategies</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Tick the strategies to compare on the Explore page, then choose Compare.
        </p>
        <Link href="/strategies" className="mt-3 inline-block text-sm font-medium text-foreground underline underline-offset-2 hover:no-underline">
          Back to Explore
        </Link>
      </section>
    );
  }

  if (load.kind === "idle" || load.kind === "loading") {
    return (
      <div role="status" aria-busy="true" aria-label="Loading the comparison" className="text-sm text-muted-foreground">
        Loading the comparison…
      </div>
    );
  }

  if (load.kind === "failed") {
    return (
      <p className="text-sm text-muted-foreground">
        {load.reason === "invalid"
          ? "Choose two or three different strategies to compare."
          : "The comparison is unavailable right now. It will load when you try again."}
      </p>
    );
  }

  return <Comparison comparison={load.comparison} />;
}

function windowLine(comparison: CompareStrategiesView): string {
  const from = formatIsoDate(comparison.windowFrom);
  const to = formatIsoDate(comparison.windowTo);
  if (!from || !to) return "No common window: at least one strategy has no published run.";
  return `Common window: ${from} to ${to}`;
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

function Comparison({ comparison }: { comparison: CompareStrategiesView }) {
  const curves = comparison.entries.map((entry) => ({
    key: entry.strategyRef,
    points: entry.series.map((p) => ({ t: p.t, v: p.equity })),
  }));
  const geometry = compareGeometry(curves, CHART.width, CHART.height);
  const named = (ref: string) => comparison.entries.find((e) => e.strategyRef === ref)?.name ?? ref;

  return (
    <div className="space-y-6">
      <p className="font-mono text-xs text-muted-foreground">{windowLine(comparison)}</p>

      <section aria-labelledby="compare-curves" className="space-y-3">
        <h2 id="compare-curves" className="text-base font-semibold">
          Growth of A$100,000
        </h2>
        {geometry.paths.some((p) => p.d) ? (
          <figure>
            <svg
              role="img"
              aria-label="Growth of A$100,000 over the common window, one line per strategy on one scale"
              viewBox={`0 0 ${CHART.width} ${CHART.height}`}
              preserveAspectRatio="none"
              className="block h-60 w-full overflow-visible"
            >
              {geometry.paths.map((path, index) =>
                path.d ? (
                  <path
                    key={path.key}
                    data-curve={path.key}
                    d={path.d}
                    fill="none"
                    stroke={STROKES[index] ?? STROKES[0]}
                    strokeWidth={1.75}
                    strokeLinejoin="round"
                    strokeDasharray={index === 2 ? "3 3" : undefined}
                    vectorEffect="non-scaling-stroke"
                  />
                ) : null,
              )}
            </svg>
            <figcaption className="mt-2 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11px] text-muted-foreground">
              {comparison.entries.map((entry, index) => (
                <span key={entry.strategyRef}>
                  <span aria-hidden="true" style={{ color: STROKES[index] }}>
                    ■
                  </span>{" "}
                  {entry.name}
                </span>
              ))}
            </figcaption>
          </figure>
        ) : (
          <p className="text-sm text-muted-foreground">No published curve covers this window yet.</p>
        )}
      </section>

      <section aria-labelledby="compare-table" className="space-y-3">
        <h2 id="compare-table" className="text-base font-semibold">
          Window figures
        </h2>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-xs">
            <caption className="sr-only">Each strategy&apos;s return, drawdown and trades over the common window</caption>
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
                <CompareRow key={entry.strategyRef} entry={entry} />
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

      <p className="text-xs text-muted-foreground">
        Hypothetical results from rules applied to historical data, not a record of trading. Not financial advice.
      </p>
    </div>
  );
}

function CompareRow({ entry }: { entry: CompareEntryView }) {
  const ret = returnText(entry.window);
  const dd = entry.window?.maxDrawdownPct;
  return (
    <tr className="border-t border-border/60">
      <th scope="row" className="px-2 py-1.5 text-left font-normal">
        {entry.name}
        {entry.window ? null : (
          <span className="block font-mono text-[10px] text-muted-foreground">No published run</span>
        )}
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
        {entry.window?.sharpe != null ? entry.window.sharpe.toFixed(2) : NOT_AVAILABLE}
      </td>
    </tr>
  );
}
