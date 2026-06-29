import Link from "next/link";
import { cn } from "@/lib/utils";

export interface HousingTile {
  label: string;
  value: string;
  delta?: string;
  tone?: "up" | "down" | null;
  sub?: string;
  href?: string;
}

/** Hairline-separated grid of region price tiles (value + YoY delta + QoQ sub). */
export function HousingTiles({
  tiles,
  className,
}: {
  tiles: HousingTile[];
  className?: string;
}) {
  if (tiles.length === 0) {
    return (
      <p className="rounded-lg border border-border bg-muted/30 p-6 text-center text-sm text-muted-foreground">
        No house-price data available yet.
      </p>
    );
  }
  return (
    <div
      className={cn(
        "grid gap-px overflow-hidden rounded-xl border border-border bg-border sm:grid-cols-2 lg:grid-cols-4",
        className,
      )}
    >
      {tiles.map((t, i) => {
        const inner = (
          <>
            <div className="text-xs font-medium text-muted-foreground">{t.label}</div>
            <div className="mt-1.5 font-mono text-2xl font-semibold tabular-nums text-foreground">
              {t.value}
            </div>
            {t.delta ? (
              <div
                className={cn(
                  "mt-1 font-mono text-xs tabular-nums",
                  t.tone === "up"
                    ? "text-[color:var(--semantic-green)]"
                    : t.tone === "down"
                      ? "text-[color:var(--semantic-red)]"
                      : "text-muted-foreground",
                )}
              >
                {t.delta}
              </div>
            ) : null}
            {t.sub ? <div className="mt-0.5 text-[11px] text-muted-foreground">{t.sub}</div> : null}
            {t.href ? (
              <div className="mt-2 text-[11px] font-medium text-muted-foreground transition-colors group-hover:text-foreground">
                View suburbs →
              </div>
            ) : null}
          </>
        );
        return t.href ? (
          <Link key={i} href={t.href} className="group block bg-card p-4 transition-colors hover:bg-muted/40 sm:p-5">{inner}</Link>
        ) : (
          <div key={i} className="bg-card p-4 sm:p-5">{inner}</div>
        );
      })}
    </div>
  );
}
