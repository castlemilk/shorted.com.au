export interface CountTileDelta {
  count: number;
  periodLabel: string;
}

export interface CountTileProps {
  count: number;
  label: string;
  delta?: CountTileDelta;
}

function safeCount(count: number): number {
  return Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0;
}

function signedCount(count: number): string {
  const value = Number.isFinite(count) ? Math.trunc(count) : 0;
  if (value < 0) return `−${Math.abs(value)}`;
  return `+${value}`;
}

export function CountTile({ count, label, delta }: CountTileProps) {
  return (
    <article className="rounded-lg border bg-card p-4">
      <div className="text-2xl font-semibold tabular-nums text-foreground">
        {safeCount(count)}
      </div>
      <div className="text-xs text-muted-foreground">{label}</div>
      {delta ? (
        <div className="mt-1 flex gap-1 text-[11px] text-muted-foreground">
          <span className="tabular-nums text-muted-foreground">
            {signedCount(delta.count)}
          </span>
          <span>{delta.periodLabel}</span>
        </div>
      ) : null}
    </article>
  );
}
