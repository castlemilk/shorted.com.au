import Link from "next/link";

import { cn } from "~/@/lib/utils";
import type { StrategyVersionDef } from "~/@/lib/strategies/types";
import { versionChipText, versionFullText } from "~/@/lib/strategies/versions";

/**
 * The rules version as a small chip, linking to its entry in the changelog.
 * Server-only:
 * it renders nothing without a version, never a placeholder label.
 */
export function VersionChip({
  version,
  className,
}: {
  version: StrategyVersionDef | null | undefined;
  className?: string;
}) {
  if (!version) return null;
  const text = versionChipText(version);
  if (!text) return null;
  return (
    <Link
      href={`/strategies/changelog#${version.rulesHash}`}
      prefetch={false}
      title={`Rules ${versionFullText(version)}. See the changelog.`}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-sm border border-border/70 px-1.5 py-0.5 font-mono text-[11px] tracking-wide text-muted-foreground hover:text-foreground",
        className,
      )}
    >
      <span className="text-foreground">Rules</span>
      <span className="tabular-nums">{text}</span>
    </Link>
  );
}
