"use client";

import React, { useEffect, useMemo, useRef } from "react";
import { cn } from "~/@/lib/utils";

type DitherBackgroundProps = {
  className?: string;
  /**
   * Size (in CSS px) of a single "pixel" in the dither texture.
   * Higher = chunkier / more visible; lower = finer / more subtle.
   */
  pixelSize?: number;
  /**
   * How strong the dither overlay is (0..1).
   * This is applied via canvas global alpha + element opacity.
   */
  intensity?: number;
};

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const clamp = (min: number, v: number, max: number) =>
  Math.max(min, Math.min(max, v));

// 8x8 Bayer matrix (0..63). Ordered dithering yields a clean "ReactBits-like" pattern.
const BAYER_8X8: ReadonlyArray<number> = [
  0, 48, 12, 60, 3, 51, 15, 63, 32, 16, 44, 28, 35, 19, 47, 31, 8, 56, 4, 52,
  11, 59, 7, 55, 40, 24, 36, 20, 43, 27, 39, 23, 2, 50, 14, 62, 1, 49, 13, 61,
  34, 18, 46, 30, 33, 17, 45, 29, 10, 58, 6, 54, 9, 57, 5, 53, 42, 26, 38, 22,
  41, 25, 37, 21,
];

/**
 * Lightweight deterministic hash-based noise (0..1) from integer coords + time.
 * Avoids Math.random() so it’s stable per frame and fast.
 */
function noise01(x: number, y: number, t: number) {
  const v = Math.sin(x * 12.9898 + y * 78.233 + t * 0.15) * 43758.5453;
  return v - Math.floor(v);
}

export function DitherBackground({
  className,
  pixelSize = 3,
  intensity = 0.22,
}: DitherBackgroundProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const bufferRef = useRef<HTMLCanvasElement | null>(null);
  const isDarkRef = useRef<boolean>(true);

  const settings = useMemo(() => {
    return {
      pixelSize: clamp(2, pixelSize, 10),
      intensity: clamp01(intensity),
    };
  }, [pixelSize, intensity]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d", { alpha: true, desynchronized: true });
    if (!ctx) return;

    // Low-res buffer canvas for crisp scaling.
    if (!bufferRef.current) {
      bufferRef.current = document.createElement("canvas");
    }
    const buffer = bufferRef.current;
    const bctx = buffer.getContext("2d", { alpha: true, desynchronized: true });
    if (!bctx) return;

    const updateTheme = () => {
      // Tailwind/shadcn convention: `dark` class toggles on <html>
      isDarkRef.current = document.documentElement.classList.contains("dark");
    };
    updateTheme();

    const resize = () => {
      const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
      canvas.width = Math.floor(window.innerWidth * dpr);
      canvas.height = Math.floor(window.innerHeight * dpr);
      canvas.style.width = "100%";
      canvas.style.height = "100%";
    };

    resize();

    let rafId = 0;
    let lastRenderAt = 0;
    const targetFPS = 12; // keep it subtle + cheap; dither doesn’t need 60fps
    const frameInterval = 1000 / targetFPS;

    const render = (now: number) => {
      rafId = window.requestAnimationFrame(render);
      if (now - lastRenderAt < frameInterval) return;
      lastRenderAt = now;

      const w = canvas.width;
      const h = canvas.height;
      if (w === 0 || h === 0) return;

      // Render at low resolution and scale up sharply for a crisp dither texture.
      const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
      const px = settings.pixelSize * dpr;
      const lw = Math.max(1, Math.floor(w / px));
      const lh = Math.max(1, Math.floor(h / px));

      if (buffer.width !== lw || buffer.height !== lh) {
        buffer.width = lw;
        buffer.height = lh;
      }

      // Reuse a single ImageData per frame (sized to low-res buffer).
      const image = ctx.createImageData(lw, lh);
      const data = image.data;

      // Palette: slight tint to match the app accent, but mostly neutral like the ReactBits sample.
      const tint = isDarkRef.current
        ? { r: 160, g: 200, b: 255 }
        : { r: 20, g: 60, b: 120 };
      const alpha = Math.round(255 * settings.intensity);

      const t = now / 1000;
      for (let y = 0; y < lh; y++) {
        const gy = y / (lh - 1 || 1);
        // Subtle vertical gradient so the dithering is actually visible (not flat noise).
        const base = isDarkRef.current ? 0.42 + gy * 0.14 : 0.58 - gy * 0.12;

        for (let x = 0; x < lw; x++) {
          const idx = (y * lw + x) * 4;

          const n = noise01(x, y, t);
          const v = clamp01(base + (n - 0.5) * 0.16);

          // Ordered dither: bias quantization using Bayer threshold.
          const bayer = BAYER_8X8[(x & 7) + ((y & 7) << 3)] ?? 0;
          const b = bayer / 64; // 0..~0.984
          const levels = 6;
          const q = clamp01((v * (levels - 1) + (b - 0.5)) / (levels - 1));

          // Map q into a light/dark stipple around midtones.
          const s = q < 0.5 ? 0 : 1;
          const mix = s ? 1 : 0;
          const r = Math.round(
            tint.r * mix + (isDarkRef.current ? 0 : 255) * (1 - mix),
          );
          const g = Math.round(
            tint.g * mix + (isDarkRef.current ? 0 : 255) * (1 - mix),
          );
          const bch = Math.round(
            tint.b * mix + (isDarkRef.current ? 0 : 255) * (1 - mix),
          );

          data[idx + 0] = r;
          data[idx + 1] = g;
          data[idx + 2] = bch;
          data[idx + 3] = alpha;
        }
      }

      // Draw low-res buffer scaled up without smoothing.
      bctx.putImageData(image, 0, 0);

      ctx.save();
      ctx.clearRect(0, 0, w, h);
      ctx.imageSmoothingEnabled = false;
      ctx.globalCompositeOperation = "source-over";
      ctx.drawImage(buffer, 0, 0, lw, lh, 0, 0, w, h);
      ctx.restore();
    };

    const onResize = () => resize();
    const onThemeToggle = () => updateTheme();

    window.addEventListener("resize", onResize, { passive: true });
    // Observe class changes on <html> to re-tint for dark/light switches.
    const observer = new MutationObserver(onThemeToggle);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });

    rafId = window.requestAnimationFrame(render);

    return () => {
      window.removeEventListener("resize", onResize);
      observer.disconnect();
      window.cancelAnimationFrame(rafId);
    };
  }, [settings.intensity, settings.pixelSize]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className={cn(
        "fixed inset-0 pointer-events-none z-0 opacity-60 mix-blend-soft-light",
        className,
      )}
    />
  );
}
