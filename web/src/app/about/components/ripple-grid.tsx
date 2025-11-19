"use client";

import { useEffect, useRef, useState } from "react";
import { useTheme } from "next-themes";

interface RippleGridProps {
  enableRainbow?: boolean;
  gridColor?: string;
  rippleIntensity?: number;
  gridSize?: number;
  gridThickness?: number;
  mouseInteraction?: boolean;
  mouseInteractionRadius?: number;
  opacity?: number;
  className?: string;
}

export function RippleGrid({
  enableRainbow = false,
  gridColor,
  rippleIntensity = 0.05,
  gridSize = 10,
  gridThickness = 15,
  mouseInteraction = true,
  mouseInteractionRadius = 1.2,
  opacity = 0.8,
  className = "",
}: RippleGridProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationFrameRef = useRef<number>();
  const { theme, systemTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  const mousePosRef = useRef({ x: 0, y: 0 });
  const ripplesRef = useRef<Array<{
    x: number;
    y: number;
    radius: number;
    maxRadius: number;
    speed: number;
    opacity: number;
  }>>([]);

  // Determine current theme
  const currentTheme = theme === "system" ? systemTheme : theme;
  const isDark = currentTheme === "dark";

  useEffect(() => {
    setMounted(true);
  }, []);

  // Also check document class for dark mode (fallback)
  useEffect(() => {
    // Update on mount and theme change
    if (mounted) {
      const observer = new MutationObserver(() => {
        // Theme changed, component will re-render
      });
      observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["class"],
      });
      return () => observer.disconnect();
    }
  }, [mounted]);

  useEffect(() => {
    if (!mounted) return;

    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) return;

    // Set canvas size
    const resizeCanvas = () => {
      const rect = canvas.getBoundingClientRect();
      canvas.width = rect.width * window.devicePixelRatio;
      canvas.height = rect.height * window.devicePixelRatio;
      ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
    };
    resizeCanvas();
    window.addEventListener("resize", resizeCanvas, { passive: true });

    // Mouse interaction
    const handleMouseMove = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      mousePosRef.current = {
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
      };

      // Create ripple on mouse move
      if (mouseInteraction) {
        ripplesRef.current.push({
          x: mousePosRef.current.x,
          y: mousePosRef.current.y,
          radius: 0,
          maxRadius: Math.max(canvas.width, canvas.height) * mouseInteractionRadius,
          speed: 2,
          opacity: rippleIntensity,
        });
      }
    };

    const handleMouseLeave = () => {
      mousePosRef.current = { x: -1, y: -1 };
    };

    if (mouseInteraction) {
      canvas.addEventListener("mousemove", handleMouseMove, { passive: true });
      canvas.addEventListener("mouseleave", handleMouseLeave, { passive: true });
    }

    // Determine grid color based on theme - matches design system colors
    const defaultGridColor = gridColor ?? (isDark 
      ? "rgba(255, 255, 255, 0.12)" 
      : "rgba(0, 0, 0, 0.12)");

    // Animation loop
    const animate = () => {
      ctx.clearRect(0, 0, canvas.width / window.devicePixelRatio, canvas.height / window.devicePixelRatio);

      const width = canvas.width / window.devicePixelRatio;
      const height = canvas.height / window.devicePixelRatio;

      // Draw grid
      ctx.strokeStyle = defaultGridColor;
      ctx.lineWidth = gridThickness / 100;
      ctx.globalAlpha = opacity;

      for (let x = 0; x <= width; x += gridSize) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, height);
        ctx.stroke();
      }

      for (let y = 0; y <= height; y += gridSize) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
        ctx.stroke();
      }

      // Update and draw ripples
      ripplesRef.current = ripplesRef.current.filter((ripple) => {
        ripple.radius += ripple.speed;
        ripple.opacity = rippleIntensity * (1 - ripple.radius / ripple.maxRadius);

        if (ripple.radius >= ripple.maxRadius || ripple.opacity <= 0) {
          return false;
        }

        // Draw ripple effect on grid
        // Ensure inner radius is never negative
        const innerRadius = Math.max(0, ripple.radius - 20);
        const gradient = ctx.createRadialGradient(
          ripple.x,
          ripple.y,
          innerRadius,
          ripple.x,
          ripple.y,
          ripple.radius
        );

        if (enableRainbow) {
          const hue = (ripple.radius * 2) % 360;
          gradient.addColorStop(0, `hsla(${hue}, 70%, 50%, ${ripple.opacity})`);
          gradient.addColorStop(1, `hsla(${hue}, 70%, 50%, 0)`);
        } else {
          // Theme-aware ripple colors that match the design system
          // Use primary blue color from theme for consistency
          if (isDark) {
            // Dark mode: subtle white with blue accent
            gradient.addColorStop(0, `rgba(255, 255, 255, ${ripple.opacity * 0.4})`);
            gradient.addColorStop(0.3, `rgba(59, 130, 246, ${ripple.opacity * 0.5})`);
            gradient.addColorStop(0.6, `rgba(59, 130, 246, ${ripple.opacity * 0.2})`);
            gradient.addColorStop(1, "transparent");
          } else {
            // Light mode: subtle black with blue accent
            gradient.addColorStop(0, `rgba(0, 0, 0, ${ripple.opacity * 0.4})`);
            gradient.addColorStop(0.3, `rgba(59, 130, 246, ${ripple.opacity * 0.5})`);
            gradient.addColorStop(0.6, `rgba(59, 130, 246, ${ripple.opacity * 0.2})`);
            gradient.addColorStop(1, "transparent");
          }
        }

        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, width, height);

        return true;
      });

      animationFrameRef.current = requestAnimationFrame(animate);
    };

    animationFrameRef.current = requestAnimationFrame(animate);

    return () => {
      window.removeEventListener("resize", resizeCanvas);
      if (mouseInteraction) {
        canvas.removeEventListener("mousemove", handleMouseMove);
        canvas.removeEventListener("mouseleave", handleMouseLeave);
      }
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    };
  }, [mounted, isDark, enableRainbow, gridColor, rippleIntensity, gridSize, gridThickness, mouseInteraction, mouseInteractionRadius, opacity]);

  if (!mounted) {
    return null;
  }

  return (
    <canvas
      ref={canvasRef}
      className={`absolute inset-0 w-full h-full ${className}`}
      style={{ pointerEvents: mouseInteraction ? "auto" : "none" }}
      aria-hidden="true"
    />
  );
}

