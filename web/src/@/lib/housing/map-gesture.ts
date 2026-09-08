/**
 * Zoom/pan smoothness for the SVG choropleth.
 *
 * Updating the `<g transform>` on every zoom event forces the browser to
 * re-rasterise every suburb path (4,500 for NSW, each with a non-scaling
 * stroke) per frame — measured 2026-09-09 at 111 of 467 pan frames over 50 ms.
 * A CSS transform on the SVG element is composited on the GPU instead: the
 * raster is scaled, not redrawn, so the gesture runs at the display's frame
 * rate. It is slightly soft while zooming in, so the exact SVG transform is
 * committed once the gesture ends and the CSS transform is cleared.
 *
 * `gestureCss` expresses the current d3-zoom transform relative to the one
 * committed at gesture start: with `transform-origin: 0 0`, screen = k·world + t,
 * so the delta from the committed (k0, t0) to the live (k, t) is a scale of
 * k/k0 about the origin followed by a translate of t − (k/k0)·t0.
 */
export type ZoomLike = { k: number; x: number; y: number };

export function gestureCss(committed: ZoomLike, live: ZoomLike): string {
  const s = live.k / committed.k;
  const dx = live.x - s * committed.x;
  const dy = live.y - s * committed.y;
  return `translate(${round(dx)}px, ${round(dy)}px) scale(${round(s, 5)})`;
}

/** True when the live transform is the committed one — nothing to composite. */
export function gestureIsIdentity(committed: ZoomLike, live: ZoomLike): boolean {
  return Math.abs(live.k - committed.k) < 1e-9
    && Math.abs(live.x - committed.x) < 1e-6
    && Math.abs(live.y - committed.y) < 1e-6;
}

function round(v: number, digits = 3): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}
