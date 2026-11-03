"use client";

import { useEffect, useRef, useState, type RefObject } from "react";

/**
 * An element's content box, followed with a ResizeObserver. The charts size
 * themselves from it rather than from a library wrapper, so a chart library's
 * own sizing never decides their geometry. Width 0 until the first measure: a
 * chart draws nothing until it knows its box.
 */
export function useElementSize<T extends HTMLElement>(): [RefObject<T | null>, { width: number; height: number }] {
  const ref = useRef<T | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => {
      const rect = el.getBoundingClientRect();
      setSize((prev) =>
        Math.round(prev.width) === Math.round(rect.width) && Math.round(prev.height) === Math.round(rect.height)
          ? prev
          : { width: Math.round(rect.width), height: Math.round(rect.height) },
      );
    };
    read();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(read);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, size];
}
