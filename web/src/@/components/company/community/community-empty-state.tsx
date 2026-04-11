import { type ReactNode } from "react";

interface CommunityEmptyStateProps {
  title: string;
  description: string;
  eyebrow?: ReactNode;
}

export function CommunityEmptyState({
  title,
  description,
  eyebrow,
}: CommunityEmptyStateProps) {
  return (
    <div className="rounded-xl border border-dashed border-border/80 bg-muted/30 p-4 sm:p-5">
      {eyebrow ? (
        <div className="mb-2 text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
          {eyebrow}
        </div>
      ) : null}
      <div className="space-y-1.5">
        <p className="text-base font-semibold text-foreground">{title}</p>
        <p className="text-sm leading-6 text-muted-foreground">
          {description}
        </p>
      </div>
    </div>
  );
}
