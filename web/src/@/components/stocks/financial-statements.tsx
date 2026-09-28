"use client";

import { useState } from "react";
import { Table2 } from "lucide-react";
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
import { cn } from "~/@/lib/utils";
import {
  NOT_AVAILABLE,
  basisDescription,
  formatAmount,
  formatPerShare,
  formatShares,
  periodColumnLabel,
} from "~/@/lib/fundamentals/format";
import {
  STATEMENT_LABELS,
  STATEMENT_LINES,
  provenanceSource,
  type FinancialStatementsProps,
  type StatementColumn,
  type StatementData,
  type StatementId,
  type StatementLineDef,
} from "./statement-lines";
import { ProvenanceLegend, ProvenanceMark } from "./provenance";

// The Financials tab's statements island (docs/plans/fundamentals-coverage.md
// §7.1, item 3): Income | Balance sheet | Cash flow, with a Half toggle.
//
// Props-only: the server (statements-shape.ts) sends data alone, already cut
// to the lines and columns that carry values. The row definitions and every
// formatter live on this side. No ~/gen, no @connectrpc, no server action:
// the stocks client-boundary test walks this file's imports.
//
// Layout rules:
//   - the Year view leads with the TTM column (when the server sent one) and
//     never shows it on the balance sheet;
//   - the Half toggle appears only when some half column carries 2+ lines of
//     the selected statement;
//   - a line renders only when a shown column has it, a column only when it
//     has a shown line;
//   - a cell whose value is not the vendor's carries a glyph, and the view's
//     glyphs are explained in a legend below the table.

type PeriodMode = "year" | "half";

function columnsFor(
  statement: StatementData,
  columns: readonly StatementColumn[],
  mode: PeriodMode,
): { columns: StatementColumn[]; lines: StatementData["lines"] } {
  const candidates = columns.filter((column) =>
    mode === "half"
      ? column.t === "half"
      : column.t === "annual" || (column.t === "ttm" && statement.id !== "balance"),
  );
  const lines = statement.lines.filter((line) =>
    candidates.some((column) => line.v[column.k] !== undefined),
  );
  const shown = candidates.filter((column) =>
    lines.some((line) => line.v[column.k] !== undefined),
  );
  return { columns: shown, lines };
}

/** A half column carries 2+ lines of this statement. */
function hasHalfView(
  statement: StatementData,
  columns: readonly StatementColumn[],
): boolean {
  return columns
    .filter((column) => column.t === "half")
    .some(
      (column) =>
        statement.lines.filter((line) => line.v[column.k] !== undefined).length >= 2,
    );
}

function formatCell(
  def: StatementLineDef,
  value: number,
  currency: string,
  mixed: boolean,
): string {
  if (def.kind === "shares") return formatShares(value);
  if (def.kind === "perShare") {
    return formatPerShare(value, currency, { mixed });
  }
  return formatAmount(value, currency, { mixed });
}

function lineDef(statementId: StatementId, lineId: string): StatementLineDef | null {
  return STATEMENT_LINES[statementId].find((line) => line.id === lineId) ?? null;
}

function StatementTable({
  code,
  statement,
  columns,
  lines,
  currency,
}: {
  code: string;
  statement: StatementData;
  columns: StatementColumn[];
  lines: StatementData["lines"];
  currency: string;
}) {
  const mixed = columns.some((column) => column.c !== undefined);
  const provenance: string[] = [];
  for (const line of lines) {
    for (const column of columns) {
      const code = line.p?.[column.k];
      if (code && line.v[column.k] !== undefined) {
        provenance.push(provenanceSource(code));
      }
    }
  }

  return (
    <div className="space-y-2">
      <div className="-mx-1 overflow-x-auto">
        <table className="w-full min-w-[20rem] border-collapse font-mono text-sm tabular-nums">
          <caption className="sr-only">
            {code} {STATEMENT_LABELS[statement.id].toLowerCase()}, newest period
            first
            {currency && !mixed ? `, figures in ${currency}` : ""}
          </caption>
          <thead>
            <tr className="border-b text-xs text-muted-foreground">
              <th scope="col" className="px-1 py-1.5 text-left font-normal">
                <span className="sr-only">Line item</span>
              </th>
              {columns.map((column) => (
                <th
                  key={column.k}
                  scope="col"
                  title={basisDescription(column.t, column.e) || undefined}
                  className="whitespace-nowrap px-1 py-1.5 text-right font-normal"
                >
                  {periodColumnLabel(column.t, column.e, column.fy)}
                  {column.c ? (
                    <span className="block text-[10px]">{column.c}</span>
                  ) : null}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y">
            {lines.map((line) => {
              const def = lineDef(statement.id, line.id);
              if (!def) return null;
              return (
                <tr key={line.id}>
                  <th
                    scope="row"
                    title={def.title}
                    className="whitespace-nowrap px-1 py-1.5 text-left text-xs font-normal text-muted-foreground"
                  >
                    {def.label}
                  </th>
                  {columns.map((column) => {
                    const value = line.v[column.k];
                    if (value === undefined) {
                      return (
                        <td
                          key={column.k}
                          className="px-1 py-1.5 text-right text-muted-foreground"
                        >
                          {NOT_AVAILABLE}
                        </td>
                      );
                    }
                    const code = line.p?.[column.k];
                    const source = code ? provenanceSource(code) : "";
                    return (
                      <td
                        key={column.k}
                        className="whitespace-nowrap px-1 py-1.5 text-right"
                      >
                        {formatCell(def, value, column.c ?? currency, mixed)}
                        {source ? <ProvenanceMark source={source} /> : null}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <ProvenanceLegend sources={provenance} />
    </div>
  );
}

interface StatementView {
  mode: PeriodMode;
  /** Both views exist and a half column carries 2+ lines: offer the toggle. */
  toggle: boolean;
  columns: StatementColumn[];
  lines: StatementData["lines"];
}

function viewFor(
  statement: StatementData,
  columns: readonly StatementColumn[],
  halfRequested: boolean,
): StatementView {
  const year = columnsFor(statement, columns, "year");
  const half = columnsFor(statement, columns, "half");
  const toggle = year.columns.length > 0 && hasHalfView(statement, columns);
  // A statement held only for halves shows them without a toggle.
  const mode: PeriodMode =
    year.columns.length === 0 || (toggle && halfRequested) ? "half" : "year";
  const chosen = mode === "half" ? half : year;
  return { mode, toggle, columns: chosen.columns, lines: chosen.lines };
}

export function FinancialStatements({
  code,
  currency,
  columns,
  statements,
}: FinancialStatementsProps) {
  const available = statements.filter(
    (statement) => viewFor(statement, columns, false).columns.length > 0,
  );
  const [selected, setSelected] = useState<StatementId>(
    available[0]?.id ?? "income",
  );
  const [halfRequested, setHalfRequested] = useState(false);

  if (available.length === 0) return null;

  const active =
    available.find((statement) => statement.id === selected) ?? available[0]!;
  const activeView = viewFor(active, columns, halfRequested);
  const mode = activeView.mode;
  const mixedCurrency = columns.some((column) => column.c !== undefined);
  const currencyNote = mixedCurrency
    ? "Reporting currency varies by period"
    : currency
      ? `Figures in ${currency}, the reporting currency`
      : "Reporting currency not stated";

  return (
    <Card role="region" aria-labelledby="financial-statements-heading">
      <CardHeader className="pb-3">
        <CardTitle
          id="financial-statements-heading"
          className="flex items-center gap-2 text-lg"
        >
          <Table2 className="h-5 w-5" aria-hidden />
          Financial statements
        </CardTitle>
        <CardDescription className="text-xs">
          {currencyNote}; Yahoo Finance unless marked
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Tabs
          value={active.id}
          onValueChange={(value) => setSelected(value as StatementId)}
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <TabsList>
              {available.map((statement) => (
                <TabsTrigger key={statement.id} value={statement.id}>
                  {STATEMENT_LABELS[statement.id]}
                </TabsTrigger>
              ))}
            </TabsList>
            {activeView.toggle ? (
              <div
                role="group"
                aria-label="Reporting period"
                className="inline-flex h-9 items-center rounded-lg bg-muted p-1 text-muted-foreground"
              >
                {(["year", "half"] as const).map((option) => (
                  <button
                    key={option}
                    type="button"
                    onClick={() => setHalfRequested(option === "half")}
                    aria-pressed={mode === option}
                    className={cn(
                      "hit-target rounded-md px-2.5 py-1 text-xs font-medium transition-[background-color,color] duration-200 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      mode === option && "bg-background text-foreground",
                    )}
                  >
                    {option === "year" ? "Year" : "Half"}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          {available.map((statement) => {
            const view =
              statement.id === active.id
                ? activeView
                : viewFor(statement, columns, halfRequested);
            return (
              <TabsContent key={statement.id} value={statement.id}>
                <StatementTable
                  code={code}
                  statement={statement}
                  columns={view.columns}
                  lines={view.lines}
                  currency={currency}
                />
              </TabsContent>
            );
          })}
        </Tabs>
      </CardContent>
    </Card>
  );
}
