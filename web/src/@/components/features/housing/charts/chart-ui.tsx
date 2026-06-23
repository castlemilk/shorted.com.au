"use client";

import { cn } from "@/lib/utils";

/** Compact segmented control used for window / mode / view toggles. */
export function SegmentedToggle<T extends string>({
  options,
  value,
  onChange,
  className,
  ariaLabel,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  className?: string;
  ariaLabel?: string;
}) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className={cn(
        "inline-flex rounded-md border border-border bg-background p-0.5",
        className,
      )}
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            "rounded px-2.5 py-1 font-mono text-[0.7rem] uppercase tracking-wider transition-colors",
            value === o.value
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Legend swatch; interactive (a toggle) when `onClick` is supplied. */
export function LegendDot({
  color,
  label,
  active = true,
  onClick,
}: {
  color: string;
  label: string;
  active?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      disabled={!onClick}
      onClick={onClick}
      aria-pressed={onClick ? active : undefined}
      className={cn(
        "inline-flex items-center gap-1.5 font-mono text-[0.7rem] transition-opacity",
        onClick ? "cursor-pointer hover:opacity-100" : "cursor-default",
        active ? "opacity-100" : "opacity-40",
      )}
    >
      <span
        className="h-2.5 w-2.5 shrink-0 rounded-full"
        style={{ backgroundColor: color }}
      />
      <span className="text-muted-foreground">{label}</span>
    </button>
  );
}
