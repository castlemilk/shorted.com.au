import Link from "next/link";
import { ChevronRight, TrendingUp, TrendingDown } from "lucide-react";
import { cn } from "~/@/lib/utils";

interface Mover {
  code: string;
  name: string;
  currentPct: number;
  previousPct: number;
  change: number;
}

interface MoversTableProps {
  movers: Mover[];
  type: "risers" | "fallers";
}

export function MoversTable({ movers, type }: MoversTableProps) {
  if (movers.length === 0) return null;

  const isRisers = type === "risers";
  const Icon = isRisers ? TrendingUp : TrendingDown;

  return (
    <div className="rounded-lg border border-border/60 overflow-hidden bg-card/50">
      <div className="grid grid-cols-[1fr_90px_90px_90px_40px] gap-3 px-4 py-3 bg-muted/50 border-b border-border/60 text-xs font-medium text-muted-foreground uppercase tracking-wider">
        <div>Stock</div>
        <div className="text-right">Previous</div>
        <div className="text-right">Current</div>
        <div className="text-right">Change</div>
        <div></div>
      </div>
      <div className="divide-y divide-border/40">
        {movers.map((mover) => (
          <Link
            key={mover.code}
            href={`/shorts/${mover.code}`}
            className="grid grid-cols-[1fr_90px_90px_90px_40px] gap-3 px-4 py-3 items-center hover:bg-muted/50 transition-colors group"
          >
            <div className="min-w-0">
              <div className="font-semibold group-hover:text-primary transition-colors">
                {mover.code}
              </div>
              <div className="text-xs text-muted-foreground truncate">
                {mover.name}
              </div>
            </div>
            <div className="text-right text-sm text-muted-foreground tabular-nums">
              {mover.previousPct.toFixed(2)}%
            </div>
            <div className="text-right text-sm font-medium tabular-nums">
              {mover.currentPct.toFixed(2)}%
            </div>
            <div className="text-right">
              <span
                className={cn(
                  "inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-semibold tabular-nums",
                  isRisers
                    ? "bg-red-500/10 text-red-500"
                    : "bg-green-500/10 text-green-500",
                )}
              >
                <Icon className="h-3 w-3" />
                {mover.change > 0 ? "+" : ""}
                {mover.change.toFixed(2)}%
              </span>
            </div>
            <div className="flex justify-end">
              <ChevronRight className="h-4 w-4 text-muted-foreground group-hover:text-foreground transition-colors" />
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
