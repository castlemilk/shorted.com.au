import { cn } from "~/@/lib/utils";

export function StatGroup({ children }: { children: React.ReactNode }) {
  return (
    <div className="my-8 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border md:grid-cols-4">
      {children}
    </div>
  );
}

export function Stat({ label, value, context, cite }: { label: string; value: string; context?: string; cite?: string }) {
  return (
    <div className="bg-card p-4">
      <div className="font-mono text-2xl font-semibold tracking-tight text-foreground">{value}</div>
      <div className="mt-1 text-[11px] uppercase tracking-wider text-muted-foreground">{label}</div>
      {context && <div className={cn("mt-1 text-xs text-muted-foreground/80")}>{context}</div>}
      {cite && (
        <sup className="text-[10px]">
          <a href={`#${cite}`} className="text-primary hover:underline" aria-label={`Source ${cite}`}>
            [{cite}]
          </a>
        </sup>
      )}
    </div>
  );
}
