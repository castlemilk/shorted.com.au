"use client";

import { useState } from "react";
import { BarChart3 } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/@/components/ui/card";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "~/@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/@/components/ui/table";
import { cn } from "~/@/lib/utils";
import type { FinancialStatements } from "~/@/types/company-metadata";

interface FinancialStatementsCardProps {
  statements: FinancialStatements;
}

/** period ISO string → metric name → value. */
type StatementGroup = Record<string, Record<string, number | null>>;
type StatementGroups = FinancialStatements["annual"];

type StatementKey = "income_statement" | "balance_sheet" | "cash_flow";
type PeriodMode = "annual" | "quarterly";

interface CuratedRow {
  metric: string;
  label: string;
  format: "currency" | "eps";
}

interface StatementDef {
  key: StatementKey;
  label: string;
  curated: CuratedRow[];
}

/**
 * Curated ordered row subsets per statement (yfinance metric names).
 * Only rows present in the data render; sparse coverage is expected —
 * e.g. banks (CBA) report no Gross Profit / Operating Income at all.
 */
const STATEMENTS: StatementDef[] = [
  {
    key: "income_statement",
    label: "Income",
    curated: [
      { metric: "Total Revenue", label: "Total revenue", format: "currency" },
      { metric: "Gross Profit", label: "Gross profit", format: "currency" },
      {
        metric: "Operating Income",
        label: "Operating income",
        format: "currency",
      },
      { metric: "Net Income", label: "Net income", format: "currency" },
      { metric: "Basic EPS", label: "Basic EPS", format: "eps" },
    ],
  },
  {
    key: "balance_sheet",
    label: "Balance sheet",
    curated: [
      { metric: "Total Assets", label: "Total assets", format: "currency" },
      {
        metric: "Total Liabilities Net Minority Interest",
        label: "Total liabilities",
        format: "currency",
      },
      {
        metric: "Stockholders Equity",
        label: "Stockholders equity",
        format: "currency",
      },
      {
        metric: "Cash And Cash Equivalents",
        label: "Cash & equivalents",
        format: "currency",
      },
      { metric: "Total Debt", label: "Total debt", format: "currency" },
    ],
  },
  {
    key: "cash_flow",
    label: "Cash flow",
    curated: [
      {
        metric: "Operating Cash Flow",
        label: "Operating cash flow",
        format: "currency",
      },
      {
        metric: "Investing Cash Flow",
        label: "Investing cash flow",
        format: "currency",
      },
      {
        metric: "Financing Cash Flow",
        label: "Financing cash flow",
        format: "currency",
      },
      { metric: "Free Cash Flow", label: "Free cash flow", format: "currency" },
      {
        metric: "Capital Expenditure",
        label: "Capital expenditure",
        format: "currency",
      },
    ],
  },
];

/** Below this many curated rows we fall back to the first metrics present. */
const MIN_CURATED_ROWS = 2;
const FALLBACK_ROW_COUNT = 8;
const MAX_PERIODS = 4;
/** Columns beyond the 2 most recent are hidden below the sm breakpoint. */
const MOBILE_VISIBLE_PERIODS = 2;

function stripTrailingZero(text: string): string {
  return text.endsWith(".0") ? text.slice(0, -2) : text;
}

/**
 * Compact AUD for raw-dollar statement values: $1.2B / $340M / $12k,
 * negatives as -$X. yfinance reports absolute dollars, so large caps
 * need a trillions tier (CBA total assets ≈ $1.4T).
 */
function formatCompactAUD(value: number): string {
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000_000) {
    return `${sign}$${stripTrailingZero((abs / 1_000_000_000_000).toFixed(1))}T`;
  }
  if (abs >= 1_000_000_000) {
    return `${sign}$${stripTrailingZero((abs / 1_000_000_000).toFixed(1))}B`;
  }
  if (abs >= 1_000_000) {
    return `${sign}$${stripTrailingZero((abs / 1_000_000).toFixed(1))}M`;
  }
  if (abs >= 1_000) {
    return `${sign}$${stripTrailingZero((abs / 1_000).toFixed(1))}k`;
  }
  return `${sign}$${stripTrailingZero(abs.toFixed(1))}`;
}

/** Per-share figures render as plain dollars ($2.35). */
function formatEPS(value: number): string {
  const sign = value < 0 ? "-" : "";
  return `${sign}$${Math.abs(value).toFixed(2)}`;
}

function formatValue(value: number, format: CuratedRow["format"]): string {
  return format === "eps" ? formatEPS(value) : formatCompactAUD(value);
}

/** "2025-06-30" → "FY25" (AU convention: FY labelled by end-date year). */
function fyLabel(periodISO: string): string {
  const yearMatch = /^(\d{4})/.exec(periodISO);
  if (yearMatch?.[1]) return `FY${yearMatch[1].slice(2)}`;
  return periodISO;
}

/** Quarterly columns get a month-year label ("Jun 25") instead of FY. */
function quarterLabel(periodISO: string): string {
  const date = new Date(periodISO);
  if (Number.isNaN(date.getTime())) return periodISO;
  return date.toLocaleDateString("en-AU", {
    month: "short",
    year: "2-digit",
    timeZone: "UTC",
  });
}

/** Most recent periods first, capped at MAX_PERIODS. ISO dates sort lexically. */
function selectPeriods(group: StatementGroup): string[] {
  return Object.keys(group)
    .sort((a, b) => b.localeCompare(a))
    .slice(0, MAX_PERIODS);
}

function metricPresent(
  group: StatementGroup,
  periods: string[],
  metric: string,
): boolean {
  return periods.some((period) => group[period]?.[metric] != null);
}

/**
 * Row set for one statement table: the curated subset when enough of it
 * exists in the data, otherwise the first FALLBACK_ROW_COUNT metrics
 * present (newest period's key order first).
 */
function buildRows(group: StatementGroup, curated: CuratedRow[]): CuratedRow[] {
  const periods = selectPeriods(group);
  const curatedPresent = curated.filter((row) =>
    metricPresent(group, periods, row.metric),
  );
  if (curatedPresent.length >= MIN_CURATED_ROWS) {
    return curatedPresent;
  }

  const seen = new Set<string>();
  const fallback: CuratedRow[] = [];
  for (const period of periods) {
    for (const metric of Object.keys(group[period] ?? {})) {
      if (seen.has(metric)) continue;
      seen.add(metric);
      if (group[period]?.[metric] == null) continue;
      fallback.push({
        metric,
        label: metric,
        format: /\bEPS\b/.test(metric) ? "eps" : "currency",
      });
      if (fallback.length >= FALLBACK_ROW_COUNT) return fallback;
    }
  }
  return fallback;
}

interface RenderableStatement {
  def: StatementDef;
  periods: string[];
  rows: CuratedRow[];
}

function buildStatements(groups?: StatementGroups): RenderableStatement[] {
  if (!groups) return [];
  const renderable: RenderableStatement[] = [];
  for (const def of STATEMENTS) {
    const group = groups[def.key];
    if (!group || Object.keys(group).length === 0) continue;
    const periods = selectPeriods(group);
    const rows = buildRows(group, def.curated);
    if (periods.length === 0 || rows.length === 0) continue;
    renderable.push({ def, periods, rows });
  }
  return renderable;
}

function StatementTable({
  statement,
  groups,
  mode,
}: {
  statement: RenderableStatement;
  groups: StatementGroups;
  mode: PeriodMode;
}) {
  const group = groups[statement.def.key];
  if (!group) return null;
  const { periods, rows } = statement;

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="px-2 sm:px-4">Metric</TableHead>
          {periods.map((period, index) => (
            <TableHead
              key={period}
              className={cn(
                "text-right px-2 sm:px-4",
                index >= MOBILE_VISIBLE_PERIODS && "hidden sm:table-cell",
              )}
            >
              {mode === "annual" ? fyLabel(period) : quarterLabel(period)}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.metric}>
            <TableCell className="text-left text-xs text-muted-foreground p-2 sm:p-4">
              {row.label}
            </TableCell>
            {periods.map((period, index) => {
              const value = group[period]?.[row.metric];
              return (
                <TableCell
                  key={period}
                  className={cn(
                    "text-right tabular-nums p-2 sm:p-4",
                    index >= MOBILE_VISIBLE_PERIODS && "hidden sm:table-cell",
                  )}
                >
                  {value == null ? (
                    <span className="text-muted-foreground">—</span>
                  ) : (
                    formatValue(value, row.format)
                  )}
                </TableCell>
              );
            })}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/**
 * Financial statements card (Financials tab): income statement, balance
 * sheet and cash flow tables from the enriched yfinance payload that
 * every GetStockDetails call already carries. Annual by default; a
 * Quarterly toggle appears only when quarterly data exists (rare —
 * none of the enriched large caps currently return it).
 */
export function FinancialStatementsCard({
  statements,
}: FinancialStatementsCardProps) {
  const annual = buildStatements(statements.annual);
  const quarterly = buildStatements(statements.quarterly);
  const modes: PeriodMode[] = [];
  if (annual.length > 0) modes.push("annual");
  if (quarterly.length > 0) modes.push("quarterly");

  const [mode, setMode] = useState<PeriodMode>(modes[0] ?? "annual");

  if (modes.length === 0) return null;

  const activeMode = modes.includes(mode) ? mode : (modes[0] ?? "annual");
  const active = activeMode === "quarterly" ? quarterly : annual;
  const groups =
    activeMode === "quarterly" ? statements.quarterly : statements.annual;
  if (!groups || active.length === 0) return null;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-lg flex items-center gap-2">
          <BarChart3 className="h-5 w-5" />
          Financial statements
        </CardTitle>
        <CardDescription>
          {activeMode === "annual" ? "Annual" : "Quarterly"} results · Source:
          Yahoo Finance
        </CardDescription>
      </CardHeader>
      <CardContent>
        {/* Key the Tabs by mode so the active statement tab resets if the
            annual/quarterly statement sets differ. */}
        <Tabs key={activeMode} defaultValue={active[0]?.def.key}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <TabsList>
              {active.map((statement) => (
                <TabsTrigger key={statement.def.key} value={statement.def.key}>
                  {statement.def.label}
                </TabsTrigger>
              ))}
            </TabsList>
            {modes.length > 1 && (
              <div
                role="group"
                aria-label="Reporting period"
                className="inline-flex h-9 items-center rounded-lg bg-muted p-1 text-muted-foreground"
              >
                {modes.map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setMode(m)}
                    aria-pressed={activeMode === m}
                    className={cn(
                      "rounded-md px-2.5 py-1 text-xs font-medium transition-[background-color,color,box-shadow] duration-200 ease-out",
                      activeMode === m &&
                        "bg-background text-foreground shadow",
                    )}
                  >
                    {m === "annual" ? "Annual" : "Quarterly"}
                  </button>
                ))}
              </div>
            )}
          </div>
          {active.map((statement) => (
            <TabsContent key={statement.def.key} value={statement.def.key}>
              {/* Shared Table renders its own overflow-auto wrapper — no
                  nested scroll container here. */}
              <StatementTable
                statement={statement}
                groups={groups}
                mode={activeMode}
              />
            </TabsContent>
          ))}
        </Tabs>
      </CardContent>
    </Card>
  );
}
