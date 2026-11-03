import { Badge } from "~/@/components/ui/badge";
import { kindInfo } from "~/@/lib/ownership/kinds";
import { cn } from "~/@/lib/utils";

// Server-safe: no "use client", no Connect import. ownership-parts.tsx
// re-exports this badge, so every ownership surface draws the same one.

/** A kind's name as a small badge with its swatch. */
export function KindBadge({ kind }: { kind: string }) {
  const info = kindInfo(kind);
  return (
    <Badge variant="outline" className="gap-1.5 whitespace-nowrap font-normal">
      <span aria-hidden className={cn("inline-block h-2 w-2 rounded-sm", info.swatch)} />
      {info.label}
    </Badge>
  );
}
