"use client";

import type { CSSProperties, ReactNode } from "react";
import {
  useParentSize,
  type ParentSizeProvidedProps,
  type UseParentSizeConfig,
} from "@visx/responsive";

export type ParentSizeProps = Pick<
  UseParentSizeConfig,
  | "debounceTime"
  | "enableDebounceLeadingCall"
  | "ignoreDimensions"
  | "initialSize"
  | "resizeObserverPolyfill"
> & {
  className?: string;
  style?: CSSProperties;
  children: (size: ParentSizeProvidedProps) => ReactNode;
};

/**
 * Measures the box it fills and passes its width and height to `children`.
 *
 * This is the layout visx 3's `ParentSize` drew, on visx 4's measuring hook.
 * visx 4's `ParentSize` puts its children in an absolutely positioned,
 * overflow-hidden box, so a wrapper whose height comes from its content (a chart
 * drawn at a fixed height) collapses to 0px, and an overlay near the edge is
 * clipped. Here the children are in flow, so the box is as tall as the content
 * it holds. Sizing is unchanged: 0 x 0 until the first measurement, then a 300 ms
 * debounce with a leading call.
 */
export function ParentSize({
  className,
  style,
  children,
  ...config
}: ParentSizeProps) {
  const { parentRef, node, resize, ...size } = useParentSize(config);
  return (
    <div
      ref={parentRef}
      className={className}
      style={{ width: "100%", height: "100%", ...style }}
    >
      {children({ ...size, ref: node, resize })}
    </div>
  );
}
