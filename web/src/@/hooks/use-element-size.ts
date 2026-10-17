"use client";

import { useCallback, useRef, useState } from "react";

export interface ElementSize {
  width: number;
  height: number;
}

/**
 * Track an element's content-box size with a ResizeObserver.
 *
 * Returns a callback ref (so it re-attaches if the element remounts) and the
 * latest size, `{0, 0}` until the first measurement. Sizes are rounded to
 * whole pixels so sub-pixel layout jitter does not re-render the consumer.
 */
export function useElementSize<T extends HTMLElement = HTMLDivElement>(): [
  (node: T | null) => void,
  ElementSize,
] {
  const [size, setSize] = useState<ElementSize>({ width: 0, height: 0 });
  const observer = useRef<ResizeObserver | null>(null);

  const ref = useCallback(
    (node: T | null) => {
      observer.current?.disconnect();
      observer.current = null;
      if (!node || typeof ResizeObserver === "undefined") return;
      const update = (width: number, height: number) => {
        const next = { width: Math.round(width), height: Math.round(height) };
        setSize((prev) =>
          prev.width === next.width && prev.height === next.height
            ? prev
            : next,
        );
      };
      const rect = node.getBoundingClientRect();
      update(rect.width, rect.height);
      const ro = new ResizeObserver((entries) => {
        const box = entries[0]?.contentRect;
        if (box) update(box.width, box.height);
      });
      ro.observe(node);
      observer.current = ro;
    },
    [],
  );

  return [ref, size];
}
