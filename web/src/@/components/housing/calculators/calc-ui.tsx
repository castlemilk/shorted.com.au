"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export const fmtAUD = (v: number) =>
  `$${Math.round(v).toLocaleString("en-AU")}`;

export const fmtAUDShort = (v: number) =>
  v >= 1_000_000
    ? `$${(v / 1_000_000).toFixed(2)}M`
    : v >= 1_000
      ? `$${Math.round(v / 1000)}k`
      : `$${Math.round(v)}`;

/** Card shell matching the /housing dashboard visual language. */
export function CalcCard({
  eyebrow,
  title,
  description,
  children,
}: {
  eyebrow: string;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-5 sm:p-6">
      <div className="font-mono text-[0.7rem] uppercase tracking-[0.2em] text-primary">
        {eyebrow}
      </div>
      <h2 className="mt-1 font-serif text-xl text-foreground sm:text-2xl">{title}</h2>
      <p className="mt-2 max-w-prose text-xs leading-relaxed text-muted-foreground">
        {description}
      </p>
      <div className="mt-5">{children}</div>
    </div>
  );
}

/**
 * Range slider + synced numeric input, styled like the widow-maker feature's
 * borrowing-power slider. Value is clamped to [min, max] on numeric entry.
 */
export function LabeledSlider({
  id,
  label,
  value,
  min,
  max,
  step,
  onChange,
  format = fmtAUDShort,
  suffix,
}: {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  format?: (v: number) => string;
  suffix?: string;
}) {
  const clamp = (v: number) => Math.min(max, Math.max(min, v));
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2 font-mono text-sm">
        <label htmlFor={id} className="text-xs text-muted-foreground">
          {label}
        </label>
        <span className="text-base font-semibold tabular-nums text-foreground">
          {format(value)}
          {suffix ? <span className="ml-0.5 text-xs text-muted-foreground">{suffix}</span> : null}
        </span>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(clamp(Number(e.target.value)))}
        className="mt-1.5 h-2 w-full cursor-pointer appearance-none rounded-full bg-muted"
        style={{ accentColor: "hsl(var(--primary))" }}
        aria-label={label}
      />
    </div>
  );
}

/** Small labelled output stat. */
export function CalcStat({
  label,
  value,
  sub,
  tone,
  big = false,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "good" | "bad";
  big?: boolean;
}) {
  return (
    <div className="rounded-lg border border-border bg-background/60 p-3">
      <div className="text-[0.65rem] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div
        className={cn(
          "mt-1 font-mono font-semibold tabular-nums",
          big ? "text-2xl" : "text-lg",
        )}
        style={
          tone
            ? { color: tone === "good" ? "var(--semantic-green)" : "var(--semantic-red)" }
            : undefined
        }
      >
        {value}
      </div>
      {sub ? <div className="mt-0.5 text-[0.7rem] text-muted-foreground">{sub}</div> : null}
    </div>
  );
}

/** Fine-print disclaimer used under each calculator. */
export function CalcDisclaimer({ children }: { children?: ReactNode }) {
  return (
    <p className="mt-4 text-[0.7rem] leading-relaxed text-muted-foreground">
      Estimates only, not financial advice; excludes LMI, fees; verify duty
      with your state revenue office.{children ? <> {children}</> : null}
    </p>
  );
}
