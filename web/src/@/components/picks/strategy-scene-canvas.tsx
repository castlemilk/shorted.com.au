"use client";

import { useEffect, useRef, useState } from "react";

import {
  SCENE_UNIT_HEIGHT,
  sceneFrame,
  type ScenePointer,
  type SceneTone,
  type SceneVariant,
} from "~/@/lib/strategies/scenes";

/**
 * The strategy scene, animated: a Canvas 2D loop over the same geometry the
 * server drew as an SVG still (lib/strategies/scenes.ts). A few kilobytes,
 * no WebGL, no three.js: the scenes are hairline strokes, and a 2D context
 * uses a capped loop for the decorative paths.
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
 *
 * It answers the reader's hand. The scene sits under the page's copy, so
 * the pointer is read on the STAGE, the nearest ancestor marked
 * `data-scene-stage` (the strategy page's header section, the hub row's
 * article), and mapped into scene units against the canvas: moving over
 * the H1 stirs the scene behind it. The pointer the geometry sees is
 * smoothed every frame, so nothing jumps, and it keeps its last place
 * after leaving, so a scene can finish what the hand started (the coil's
 * release). Touch is a tap: pointerdown places the hand, pointerup lifts
 * it; nothing is prevented, so the page still scrolls. Keyboard focus is
 * not involved: the scene is decorative and carries no meaning.
 */

/** Per-frame easing of the pointer the scene sees toward the real one. */
const POINTER_EASE = 0.22;

/** The stage: where pointer events are read for a scene. */
export function sceneStageOf(canvas: HTMLElement): HTMLElement {
  return canvas.closest<HTMLElement>("[data-scene-stage]") ?? canvas;
}

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
  const [reducedMotion, setReducedMotion] = useState(false);

  useEffect(() => {
    const preference = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!preference) return;
    const sync = () => setReducedMotion(preference.matches);
    sync();
    preference.addEventListener?.("change", sync);
    return () => preference.removeEventListener?.("change", sync);
  }, []);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    if (reducedMotion || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
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

    // The hand: the real pointer in scene units, the eased one the
    // geometry reads, and when it arrived or left.
    let target: { x: number; y: number } | null = null;
    let hand: ScenePointer | null = null;
    let arrived = 0;
    let departed = 0;
    const stage = sceneStageOf(canvas);
    const place = (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      if (scale <= 0) return;
      const x = (event.clientX - rect.left) / scale;
      const y = (event.clientY - rect.top) / scale;
      if (!target) {
        target = { x, y };
        hand = { x, y, since: 0, left: null };
        arrived = performance.now();
      } else {
        target.x = x;
        target.y = y;
        if (typeof hand?.left === "number") {
          hand.left = null;
          arrived = performance.now();
        }
      }
      schedule();
    };
    const lift = () => {
      if (!target) return;
      target = null;
      departed = performance.now();
      if (hand) hand.left = 0;
      schedule();
    };
    const onPointerMove = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      place(event);
    };
    const onPointerDown = (event: PointerEvent) => {
      if (event.pointerType !== "touch") return;
      place(event);
    };
    const onPointerUp = (event: PointerEvent) => {
      if (event.pointerType !== "touch") return;
      lift();
    };

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
      if (hand) {
        if (target) {
          hand.x += (target.x - hand.x) * POINTER_EASE;
          hand.y += (target.y - hand.y) * POINTER_EASE;
          hand.since = (now - arrived) / 1000;
        } else {
          hand.left = (now - departed) / 1000;
          // Two seconds after leaving, the hand is forgotten entirely.
          if (hand.left > 2) hand = null;
        }
      }
      if (scale > 0 && width > 0) {
        const unitWidth = width / scale;
        const frame = sceneFrame(slug, unitWidth, SCENE_UNIT_HEIGHT, (now - start) / 1000, hand ?? undefined);
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
    stage.addEventListener("pointermove", onPointerMove, { passive: true });
    stage.addEventListener("pointerleave", lift, { passive: true });
    stage.addEventListener("pointerdown", onPointerDown, { passive: true });
    stage.addEventListener("pointerup", onPointerUp, { passive: true });
    stage.addEventListener("pointercancel", onPointerUp, { passive: true });
    schedule();

    return () => {
      if (raf) cancelAnimationFrame(raf);
      ro?.disconnect();
      io?.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      stage.removeEventListener("pointermove", onPointerMove);
      stage.removeEventListener("pointerleave", lift);
      stage.removeEventListener("pointerdown", onPointerDown);
      stage.removeEventListener("pointerup", onPointerUp);
      stage.removeEventListener("pointercancel", onPointerUp);
      host?.removeAttribute("data-scene-live");
    };
  }, [slug, variant, reducedMotion]);

  return (
    <canvas
      ref={ref}
      aria-hidden="true"
      data-scene-canvas={variant}
      className="absolute inset-0 h-full w-full"
    />
  );
}
