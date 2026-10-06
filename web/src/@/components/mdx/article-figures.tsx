/**
 * Article figures owned by Shorted. These components render on the server and
 * need no browser runtime. Markdown children are rendered unchanged: inspecting
 * React child types cannot reliably recover content across the RSC boundary.
 *
 * Data props accept typed arrays in React or literal JSON string attributes in
 * MDX. next-mdx-remote's safe default removes JavaScript expression attributes,
 * so MDX authors should write items='[{"label":"Darwin","value":25}]'.
 */
import React, { isValidElement, type ReactElement, type ReactNode } from "react";
import { entries, number, numeric, parseRankItems, parseStatItems, record, text, type FigureData, type RankItem, type StatItem } from "./article-figure-data";
export type { RankItem, StatItem } from "./article-figure-data";

export interface FigureProps {
  title?: string;
  corner?: string;
  className?: string;
  children?: ReactNode;
}

type Data<T> = FigureData<T>;

function format(value: number): string {
  return value.toLocaleString("en-AU", { maximumFractionDigits: 2 });
}

const prose = "text-sm leading-7 text-foreground [&>p]:my-3 [&>p:first-child]:mt-0 [&>p:last-child]:mb-0 [&_a]:text-primary [&_a]:underline [&_strong]:font-semibold [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-2";

function Markdown({ children }: { children: ReactNode }) {
  return <div className={prose}>{children}</div>;
}

function ArticleFigure({ title, corner, className, children }: FigureProps) {
  return (
    <figure data-article-figure className={`not-prose my-8 overflow-hidden rounded-lg border border-border bg-card font-mono text-sm text-card-foreground ${className ?? ""}`}>
      {Boolean(title) || Boolean(corner) ? (
        <figcaption className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border px-5 py-4 sm:px-6">
          {title ? <span className="font-semibold leading-snug">{title}</span> : null}
          {corner ? <span className="text-xs text-muted-foreground">{corner}</span> : null}
        </figcaption>
      ) : null}
      <div className="p-5 sm:p-6">{children}</div>
    </figure>
  );
}

function Empty({ children }: { children?: ReactNode }) {
  return children ? <Markdown>{children}</Markdown> : <p className="text-sm text-muted-foreground">No data available.</p>;
}

export interface CalloutProps extends FigureProps {
  type?: "note" | "tip" | "warning" | "danger";
}

export function Callout({ type = "note", title, corner, className, children }: CalloutProps) {
  const tone = type === "danger" || type === "warning" ? "border-accent/50" : "border-primary/30";
  return (
    <aside data-article-callout role="note" className={`not-prose my-8 rounded-lg border bg-muted/50 p-5 font-mono text-sm text-foreground sm:p-6 ${tone} ${className ?? ""}`}>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <p className="m-0 font-semibold">{title ?? (type.charAt(0).toUpperCase() + type.slice(1))}</p>
        {corner ? <span className="text-xs text-muted-foreground">{corner}</span> : null}
      </div>
      <Markdown>{children}</Markdown>
    </aside>
  );
}

export interface QuoteProps extends FigureProps {
  by?: string;
  source?: string;
}

export function Quote({ by, source, children, ...frame }: QuoteProps) {
  return (
    <ArticleFigure {...frame}>
      <blockquote className="m-0 border-l border-primary/50 pl-5">
        <div className={`${prose} text-base italic`}>{children}</div>
        {Boolean(by) || Boolean(source) ? (
          <footer className="mt-4 text-sm text-muted-foreground">
            {by ? <span className="font-medium text-foreground">{by}</span> : null}
            {by && source ? " · " : null}
            {source ? <cite className="not-italic">{source}</cite> : null}
          </footer>
        ) : null}
      </blockquote>
    </ArticleFigure>
  );
}

export interface StepItem {
  title: string;
  description?: string;
  state?: "done" | "now" | "next";
}

export interface StepsProps extends FigureProps {
  items?: Data<StepItem>;
}

export function Steps({ items, children, ...frame }: StepsProps) {
  const steps = entries(items, (value): value is StepItem => record(value) && text(value.title) &&
    (value.description === undefined || text(value.description)) &&
    (value.state === undefined || ["done", "now", "next"].includes(String(value.state))), "items");
  return (
    <ArticleFigure {...frame}>
      <div className={`${prose} [&>ol]:m-0 [&>ol]:space-y-6 [&>ol]:pl-6 [&>ol>li]:pl-2 [&>ol>li::marker]:font-semibold [&>ol>li::marker]:text-primary [&>ol>li>p]:my-2 [&>ol>li>p:first-child]:mt-0 [&>ol>li>p:first-child]:font-semibold`}>
        {steps.length ? (
          <ol>
            {steps.map((step, index) => (
              <li key={index} data-state={step.state}>
                <p className="m-0 font-semibold">{step.title}</p>
                {step.description ? <p className="mt-1 text-muted-foreground">{step.description}</p> : null}
              </li>
            ))}
          </ol>
        ) : children}
      </div>
    </ArticleFigure>
  );
}

export interface GraphStatProps extends FigureProps {
  items?: Data<StatItem>;
}

export function GraphStat({ items, children, ...frame }: GraphStatProps) {
  const stats = parseStatItems(items);
  return (
    <ArticleFigure {...frame}>
      {stats.length ? (
        <dl className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {stats.map((stat, index) => (
            <div key={index} className="flex flex-col gap-1 border-l border-border pl-4">
              <dt className="order-2 text-sm text-muted-foreground">{stat.label}</dt>
              <dd className={`order-1 m-0 text-3xl font-semibold tracking-tight tabular-nums ${stat.accent ? "text-primary" : "text-foreground"}`}>{stat.value}</dd>
              {stat.hint ? <dd className="order-3 m-0 mt-1 text-xs text-muted-foreground">{stat.hint}</dd> : null}
            </div>
          ))}
        </dl>
      ) : <Empty>{children}</Empty>}
    </ArticleFigure>
  );
}

export interface GraphRankProps extends FigureProps {
  items?: Data<RankItem>;
  max?: number | string;
}

export function GraphRank({ items, max, children, ...frame }: GraphRankProps) {
  const ranks = parseRankItems(items);
  const scale = Math.max(max !== undefined && numeric(max) ? Math.abs(number(max)) : 0, ...ranks.map((rank) => Math.abs(number(rank.value))), 1);
  return (
    <ArticleFigure {...frame}>
      {ranks.length ? (
        <ol className="m-0 list-none space-y-4 p-0">
          {ranks.map((rank, index) => (
            <li key={index}>
              <div className="mb-1.5 flex items-baseline justify-between gap-3 text-sm">
                <span>{rank.label}</span>
                <span className="font-medium tabular-nums">{rank.display ?? format(number(rank.value))}</span>
              </div>
              <div aria-hidden="true" className="h-2 overflow-hidden rounded-full bg-muted">
                <div className={`h-full rounded-full ${rank.accent ? "bg-primary" : "bg-primary/70"}`} style={{ width: `${Math.abs(number(rank.value)) / scale * 100}%` }} />
              </div>
            </li>
          ))}
        </ol>
      ) : <Empty>{children}</Empty>}
    </ArticleFigure>
  );
}

export interface GraphTableProps extends FigureProps {
  headers?: Data<string>;
  rows?: Data<readonly (string | number | null | ReactElement)[]>;
  footer?: readonly (string | number | null | ReactElement)[];
  align?: readonly ("left" | "right")[];
}

const tableStyles = "overflow-x-auto text-sm [&_table]:my-0 [&_table]:w-full [&_table]:border-collapse [&_th]:border-b [&_th]:border-border [&_th]:bg-muted/50 [&_th]:px-4 [&_th]:py-3 [&_th]:text-left [&_th]:font-semibold [&_td]:border-b [&_td]:border-border [&_td]:px-4 [&_td]:py-3 [&_td]:align-top [&_tr:last-child_td]:border-b-0 [&_a]:text-primary [&_a]:underline";

export function GraphTable({ headers, rows, footer, align, children, ...frame }: GraphTableProps) {
  const columns = entries(headers, text, "headers");
  const tableRows = entries(rows, (value): value is readonly (string | number | null | ReactElement)[] => Array.isArray(value) && value.every((cell) =>
    cell === null || typeof cell === "string" || (typeof cell === "number" && Number.isFinite(cell)) || isValidElement(cell as unknown)), "rows");
  return (
    <ArticleFigure {...frame}>
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- A scroll region needs focus for arrow-key scrolling. */}
      <div role="region" aria-label={frame.title ?? "Article table"} tabIndex={0} className={`${tableStyles} [&_table]:min-w-[36rem] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary`}>
        {columns.length || tableRows.length ? (
          <table>
            {columns.length ? <thead><tr>{columns.map((column, index) => <th key={index} scope="col" style={{ textAlign: align?.[index] }}>{column}</th>)}</tr></thead> : null}
            <tbody>{tableRows.map((row, index) => <tr key={index}>{row.map((cell, column) => <td key={column} style={{ textAlign: align?.[column] }}>{cell}</td>)}</tr>)}</tbody>
            {footer ? <tfoot><tr>{footer.map((cell, index) => <td key={index}>{cell}</td>)}</tr></tfoot> : null}
          </table>
        ) : children}
      </div>
    </ArticleFigure>
  );
}

function series(data: Data<number>): readonly number[] {
  if (typeof data === "string" && !data.trim().startsWith("[")) {
    const values = data.trim() ? data.trim().split(/[\s,]+/).map(Number) : [];
    if (!values.every(Number.isFinite)) throw new Error("Article figure data must contain finite numbers.");
    return values;
  }
  return entries(data, (value): value is number => typeof value === "number" && Number.isFinite(value), "data");
}

function Sparkline({ data }: { data: readonly number[] }) {
  const low = Math.min(...data);
  const high = Math.max(...data);
  const range = high - low || 1;
  const points = data.map((value, index) => `${data.length === 1 ? 150 : 8 + index / (data.length - 1) * 284},${72 - (value - low) / range * 56}`).join(" ");
  return (
    <>
      <svg aria-hidden="true" viewBox="0 0 300 88" className="h-24 w-full text-primary" preserveAspectRatio="none">
        <line x1="8" y1="80" x2="292" y2="80" stroke="currentColor" strokeOpacity="0.15" />
        {data.length > 1 ? <polyline points={points} fill="none" stroke="currentColor" strokeWidth="2.5" vectorEffect="non-scaling-stroke" /> : <circle cx="150" cy="72" r="3" fill="currentColor" />}
      </svg>
      <p className="sr-only">Values in order: {data.map(format).join(", ")}.</p>
    </>
  );
}

export interface GraphSparkProps extends FigureProps {
  data: Data<number>;
  caption?: string;
}

export function GraphSpark({ data, caption, ...frame }: GraphSparkProps) {
  const values = series(data);
  return (
    <ArticleFigure {...frame}>
      {values.length ? <Sparkline data={values} /> : <Empty />}
      {caption ? <p className="mt-3 text-sm text-muted-foreground">{caption}</p> : null}
    </ArticleFigure>
  );
}

export interface GraphKpiProps extends GraphSparkProps {
  value: string | number;
  label: string;
  hint?: string;
}

export function GraphKpi({ value, label, hint, data, ...frame }: GraphKpiProps) {
  const values = series(data);
  return (
    <ArticleFigure {...frame}>
      <dl>
        <dt className="text-sm text-muted-foreground">{label}</dt>
        <dd className="m-0 mt-2 text-4xl font-semibold tracking-tight tabular-nums text-primary">{value}</dd>
      </dl>
      {hint ? <p className="mt-2 text-sm text-muted-foreground">{hint}</p> : null}
      {values.length ? <Sparkline data={values} /> : null}
    </ArticleFigure>
  );
}

export interface GraphMeterProps extends FigureProps {
  value: number | string;
  caption?: string;
}

export function GraphMeter({ value, caption, ...frame }: GraphMeterProps) {
  if (!numeric(value)) throw new Error("Article figure value must be a finite number or percentage.");
  const proportion = Math.min(1, Math.max(0, typeof value === "string" && value.includes("%") ? number(value) / 100 : number(value)));
  const percent = format(proportion * 100);
  return (
    <ArticleFigure {...frame}>
      <div className="flex items-center gap-4">
        <meter min="0" max="1" value={proportion} aria-label={caption ?? frame.title ?? "Progress"} className="sr-only">{percent}%</meter>
        <div aria-hidden="true" className="h-3 flex-1 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-primary" style={{ width: `${proportion * 100}%` }} /></div>
        <span className="text-lg font-semibold tabular-nums">{percent}%</span>
      </div>
      {caption ? <p className="mt-3 text-sm text-muted-foreground">{caption}</p> : null}
    </ArticleFigure>
  );
}

export interface SlopeItem {
  label: string;
  from: number | string;
  to: number | string;
}

export interface GraphSlopeProps extends FigureProps {
  fromLabel: string;
  toLabel: string;
  items?: Data<SlopeItem>;
}

export function GraphSlope({ fromLabel, toLabel, items, children, ...frame }: GraphSlopeProps) {
  const slopes = entries(items, (value): value is SlopeItem => record(value) && text(value.label) && numeric(value.from) && numeric(value.to), "items");
  const all = slopes.flatMap((slope) => [number(slope.from), number(slope.to)]);
  const low = Math.min(0, ...all);
  const high = Math.max(...all, 1);
  const y = (value: number) => 48 - (value - low) / (high - low) * 40;
  return (
    <ArticleFigure {...frame}>
      {slopes.length ? (
        // A scroll region needs focus for arrow-key scrolling.
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
        <div role="region" aria-label={frame.title ?? "Before and after table"} tabIndex={0} className={`${tableStyles} focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary`}>
          <table><thead><tr><th scope="col">Series</th><th scope="col">{fromLabel}</th><th aria-label="Trend" scope="col" /><th scope="col">{toLabel}</th></tr></thead>
            <tbody>{slopes.map((slope, index) => <tr key={index}>
              <th scope="row">{slope.label}</th><td className="tabular-nums">{format(number(slope.from))}</td>
              <td><svg aria-hidden="true" viewBox="0 0 100 56" className="h-12 w-24 text-primary"><line x1="8" y1={y(number(slope.from))} x2="92" y2={y(number(slope.to))} stroke="currentColor" strokeWidth="2" /><circle cx="8" cy={y(number(slope.from))} r="3" fill="currentColor" /><circle cx="92" cy={y(number(slope.to))} r="3" fill="currentColor" /></svg></td>
              <td className="tabular-nums">{format(number(slope.to))}</td>
            </tr>)}</tbody>
          </table>
        </div>
      ) : <Empty>{children}</Empty>}
    </ArticleFigure>
  );
}

export interface TimelineEvent {
  date: string;
  label: string;
  state?: "done" | "now" | "next";
}

export interface GraphTimelineProps extends FigureProps {
  events?: Data<TimelineEvent>;
}

export function GraphTimeline({ events, children, ...frame }: GraphTimelineProps) {
  const timeline = entries(events, (value): value is TimelineEvent => record(value) && text(value.date) && text(value.label) &&
    (value.state === undefined || ["done", "now", "next"].includes(String(value.state))), "events");
  return (
    <ArticleFigure {...frame}>
      {timeline.length ? (
        <ol className="ml-2 space-y-6 border-l border-border">
          {timeline.map((event, index) => <li key={index} className="relative pl-6">
            <span aria-hidden="true" className={`absolute -left-1.5 top-1.5 h-3 w-3 rounded-full border-2 border-card ${event.state === "next" ? "bg-muted-foreground" : "bg-primary"}`} />
            <p className="text-xs font-medium text-muted-foreground">{event.date}</p><p className="mt-1 text-sm">{event.label}</p>
            {event.state ? <span className="sr-only">{event.state === "now" ? "Current" : event.state === "next" ? "Upcoming" : "Completed"}</span> : null}
          </li>)}
        </ol>
      ) : <Empty>{children}</Empty>}
    </ArticleFigure>
  );
}

export interface WaterfallItem extends Omit<RankItem, "accent"> {
  kind?: "start" | "in" | "out" | "end";
}

export interface GraphWaterfallProps extends FigureProps {
  items?: Data<WaterfallItem>;
}

export function GraphWaterfall({ items, children, ...frame }: GraphWaterfallProps) {
  const changes = entries(items, (value): value is WaterfallItem => record(value) && text(value.label) && numeric(value.value) &&
    (value.display === undefined || text(value.display)) &&
    (value.kind === undefined || ["start", "in", "out", "end"].includes(String(value.kind))), "items");
  let total = 0;
  const bars = changes.map((item, index) => {
    const value = number(item.value);
    const kind = item.kind ?? (index === 0 ? "start" : index === changes.length - 1 ? "end" : value < 0 ? "out" : "in");
    const start = kind === "start" || kind === "end" ? 0 : total;
    total = kind === "start" || kind === "end" ? value : total + value;
    return { ...item, value, kind, start, end: total };
  });
  const low = Math.min(0, ...bars.flatMap((bar) => [bar.start, bar.end]));
  const high = Math.max(1, ...bars.flatMap((bar) => [bar.start, bar.end]));
  const position = (value: number) => (value - low) / (high - low) * 100;
  return (
    <ArticleFigure {...frame}>
      {bars.length ? <ol className="space-y-4">
        {bars.map((bar, index) => <li key={index}>
          <div className="mb-1.5 flex justify-between gap-3 text-sm"><span>{bar.label}</span><span className="font-medium tabular-nums">{bar.display ?? `${bar.kind === "in" && bar.value > 0 ? "+" : ""}${format(bar.value)}`}</span></div>
          <div aria-hidden="true" className="relative h-3 rounded bg-muted">
            <span className="absolute -top-1 h-5 w-px bg-muted-foreground/50" style={{ left: `${position(0)}%` }} />
            <span className={`absolute h-3 rounded ${bar.kind === "out" ? "bg-destructive/70" : "bg-primary/80"}`} style={{ left: `${position(Math.min(bar.start, bar.end))}%`, width: `${Math.abs(position(bar.end) - position(bar.start))}%` }} />
          </div>
        </li>)}
      </ol> : <Empty>{children}</Empty>}
    </ArticleFigure>
  );
}

export type CompareCell = string | boolean;
export interface CompareRow {
  label: string;
  values: readonly CompareCell[];
}

export interface GraphCompareProps extends FigureProps {
  columns?: Data<string>;
  rows?: Data<CompareRow>;
  accent?: string;
}

export function GraphCompare({ columns, rows, accent, children, ...frame }: GraphCompareProps) {
  const options = entries(columns, text, "columns");
  const comparisons = entries(rows, (value): value is CompareRow => record(value) && text(value.label) && Array.isArray(value.values) &&
    value.values.every((cell) => typeof cell === "string" || typeof cell === "boolean"), "rows");
  return (
    <ArticleFigure {...frame}>
      {options.length && comparisons.length ? (
        // A scroll region needs focus for arrow-key scrolling.
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
        <div role="region" aria-label={frame.title ?? "Comparison table"} tabIndex={0} className={`${tableStyles} focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary`}>
          <table><thead><tr><th scope="col">Feature</th>{options.map((option, index) => <th key={index} scope="col" className={option === accent ? "text-primary" : ""}>{option}</th>)}</tr></thead>
            <tbody>{comparisons.map((row, index) => <tr key={index}><th scope="row">{row.label}</th>{options.map((option, column) => <td key={column} className={option === accent ? "bg-primary/5" : ""}>{row.values[column] === true ? "Yes" : row.values[column] === false ? "No" : row.values[column] ?? "—"}</td>)}</tr>)}</tbody>
          </table>
        </div>
      ) : <Empty>{children}</Empty>}
    </ArticleFigure>
  );
}

export interface FlowNode {
  label: string;
  tone?: "default" | "accent" | "muted";
  stretch?: boolean;
}

export interface FlowRow {
  nodes: readonly FlowNode[];
}

export interface GraphFlowProps extends FigureProps {
  rows?: Data<FlowRow>;
}

export function GraphFlow({ rows, children, ...frame }: GraphFlowProps) {
  const paths = entries(rows, (value): value is FlowRow => record(value) && Array.isArray(value.nodes) && value.nodes.every((node) =>
    record(node) && text(node.label) && (node.tone === undefined || ["default", "accent", "muted"].includes(String(node.tone))) &&
    (node.stretch === undefined || typeof node.stretch === "boolean")), "rows");
  return (
    <ArticleFigure {...frame}>
      {paths.length ? <div className="space-y-4">
        {paths.map((path, row) => <ol key={row} className="flex flex-wrap items-center gap-y-3">
          {path.nodes.map((node, index) => <li key={index} className={`flex items-center ${node.stretch ? "flex-1" : ""}`}>
            {index > 0 ? <span aria-hidden="true" className="mx-3 text-muted-foreground">→</span> : null}
            <span className={`rounded-lg border px-4 py-3 text-sm ${node.tone === "accent" ? "border-primary bg-primary/10 font-medium text-primary" : node.tone === "muted" ? "border-border bg-muted text-muted-foreground" : "border-border"} ${node.stretch ? "flex-1" : ""}`}>{node.label}</span>
          </li>)}
        </ol>)}
      </div> : <Empty>{children}</Empty>}
    </ArticleFigure>
  );
}

/** Shared by blogs, newsroom MDX and Next's MDX component entry points. */
export const articleFigureComponents = {
  Callout, Quote, Steps, GraphStat, GraphKpi, GraphSlope, GraphRank,
  GraphTimeline, GraphTable, GraphSpark, GraphMeter, GraphWaterfall,
  GraphCompare, GraphFlow,
};
