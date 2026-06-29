"use client";

/**
 * Swatch legend for the categorical highlight metrics (religion, language). Only
 * the categories actually present in the current state are passed in, so the key
 * stays relevant. Mirrors MapLegend's card styling.
 */
export function CategoricalLegend({
  label, entries, showNoData = true,
}: {
  label: string;
  entries: { label: string; color: string }[];
  showNoData?: boolean;
}) {
  return (
    <div className="pointer-events-none max-w-[230px] rounded-lg border border-border bg-card/90 px-3 py-2 shadow-sm backdrop-blur">
      <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
      <ul className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-1">
        {entries.map((e) => (
          <li key={e.label} className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
            <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm border border-border/40" style={{ background: e.color }} />
            <span className="truncate" title={e.label}>{e.label}</span>
          </li>
        ))}
      </ul>
      {showNoData ? (
        <div className="mt-1.5 flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <span
            className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm border border-border"
            style={{
              backgroundImage:
                "repeating-linear-gradient(45deg, hsl(var(--muted)), hsl(var(--muted)) 2px, hsl(var(--border)) 2px, hsl(var(--border)) 3px)",
            }}
          />
          No data
        </div>
      ) : null}
    </div>
  );
}
