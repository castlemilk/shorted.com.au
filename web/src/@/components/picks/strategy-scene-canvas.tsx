"use client";

import { useEffect, useRef } from "react";

import {
  SCENE_UNIT_HEIGHT,
  sceneFrame,
  type SceneTone,
  type SceneVariant,
} from "~/@/lib/strategies/scenes";

/**
 * The strategy scene, animated: a Canvas 2D loop over the same geometry the
 * server drew as an SVG still (lib/strategies/scenes.ts). A few kilobytes,
 * no WebGL, no three.js: the scenes are hairline strokes, and a 2D context
 * draws forty paths thirty times a second for nothing.
 *
 * It is a layer OVER the still, not a replacement. The still is in the ISR
 * HTML, so the scene is there at first paint, for a crawler, without
 * JavaScript, and under prefers-reduced-motion (this component then draws
 * nothing at all). Once the first frame is on the canvas the host gets
 * `data-scene-live`, and globals.css fades the still out beneath it.
 *
 * Cheap by construction: at most 30 frames a second, nothing while the
 * canvas is off screen or the tab is hidden (an IntersectionObserver and
 * visibilitychange gate the loop), the device pixel ratio capped at 2, and
 * the theme's colours read from the document's custom properties every
 * couple of seconds, so a theme switch recolours the scene.
 */

const TONE_VAR: Record<SceneTone, string> = {
  ink: "--foreground",
  amber: "--primary",
  olive: "--secondary",
  rust: "--accent",
  muted: "--muted-foreground",
};

/** DESIGN.md's light-room values, for a document without the variables. */
const FALLBACK: Record<SceneTone, string> = {
  ink: "#483932",
  amber: "#9E5210",
  olive: "#87A86B",
  rust: "#D06D49",
  muted: "#72625A",
};

const FRAME_MS = 1000 / 30;
const PALETTE_EVERY_FRAMES = 60;

function readPalette(): Record<SceneTone, string> {
  const style = getComputedStyle(document.documentElement);
  const palette = { ...FALLBACK };
  for (const tone of Object.keys(TONE_VAR) as SceneTone[]) {
    const value = style.getPropertyValue(TONE_VAR[tone]).trim();
    if (value) palette[tone] = `hsl(${value})`;
  }
  return palette;
}

export function StrategySceneCanvas({
  slug,
  variant,
}: {
  slug: string;
  variant: SceneVariant;
}) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const host = canvas.parentElement;

    let palette = readPalette();
    let paletteAge = 0;
    let width = 0;
    let height = 0;
    let dpr = 1;
    let scale = 0;
    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      width = rect.width;
      height = rect.height;
      dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.max(1, Math.round(width * dpr));
      canvas.height = Math.max(1, Math.round(height * dpr));
      scale = height / SCENE_UNIT_HEIGHT;
    };
    resize();

    let visible = true;
    let raf = 0;
    let last = 0;
    let live = false;
    const start = performance.now();

    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(draw);
    };
    const draw = (now: number) => {
      raf = 0;
      if (!visible || document.hidden) return;
      if (now - last < FRAME_MS) {
        schedule();
        return;
      }
      last = now;
      if (++paletteAge >= PALETTE_EVERY_FRAMES) {
        palette = readPalette();
        paletteAge = 0;
      }
      if (scale > 0 && width > 0) {
        const unitWidth = width / scale;
        const frame = sceneFrame(slug, unitWidth, SCENE_UNIT_HEIGHT, (now - start) / 1000);
        ctx.setTransform(dpr * scale, 0, 0, dpr * scale, 0, 0);
        ctx.clearRect(0, 0, unitWidth, SCENE_UNIT_HEIGHT);
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        for (const p of frame.paths) {
          const path = new Path2D(p.d);
          ctx.globalAlpha = p.opacity;
          if (p.fill) {
            ctx.fillStyle = palette[p.tone];
            ctx.fill(path);
            continue;
          }
          ctx.strokeStyle = palette[p.tone];
          // Widths are CSS pixels, like the still's non-scaling strokes.
          ctx.lineWidth = Math.max(1, p.width) / scale;
          ctx.setLineDash(p.dash ? p.dash.split(/[\s,]+/).map(Number) : []);
          ctx.lineDashOffset = p.dashOffset ?? 0;
          ctx.stroke(path);
        }
        if (!live) {
          live = true;
          host?.setAttribute("data-scene-live", "");
        }
      }
      schedule();
    };

    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(resize) : null;
    ro?.observe(canvas);
    const io =
      typeof IntersectionObserver !== "undefined"
        ? new IntersectionObserver((entries) => {
            visible = entries.some((entry) => entry.isIntersecting);
            if (visible) schedule();
          })
        : null;
    io?.observe(canvas);
    const onVisibility = () => {
      if (!document.hidden) schedule();
    };
    document.addEventListener("visibilitychange", onVisibility);
    schedule();

    return () => {
      if (raf) cancelAnimationFrame(raf);
      ro?.disconnect();
      io?.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      host?.removeAttribute("data-scene-live");
    };
  }, [slug, variant]);

  return (
    <canvas
      ref={ref}
      aria-hidden="true"
      data-scene-canvas={variant}
      className="absolute inset-0 h-full w-full"
    />
  );
}
