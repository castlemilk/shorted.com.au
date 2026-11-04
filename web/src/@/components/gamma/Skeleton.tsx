import type { CSSProperties } from "react";

export type SkeletonProps = {
  width?: number | string;
  height?: number | string;
  shape?: "line" | "circle" | "rounded";
  animation?: "shimmer" | "pulse" | "none";
  className?: string;
};

/** Decorative placeholder. Put a loading status on the containing region. */
export function Skeleton({
  width = "100%",
  height = 12,
  shape = "line",
  animation = "shimmer",
  className = "",
}: SkeletonProps) {
  return (
    <span
      className={`gamma-skeleton gamma-skeleton-${shape} gamma-skeleton-${animation} ${className}`}
      style={{ width, height } satisfies CSSProperties}
      aria-hidden="true"
    />
  );
}
