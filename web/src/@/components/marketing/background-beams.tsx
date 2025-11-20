"use client";

import { useEffect, useRef } from "react";
import { cn } from "~/@/lib/utils";

export const BackgroundBeams = ({ className }: { className?: string }) => {
  const beamsRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = beamsRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let animationFrameId: number;
    const beams: Beam[] = [];
    const numBeams = 20;

    const resize = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    };

    class Beam {
      x: number;
      y: number;
      length: number;
      speed: number;
      angle: number;
      opacity: number;
      width: number;

      constructor() {
        this.x = Math.random() * canvas!.width;
        this.y = Math.random() * canvas!.height;
        this.length = Math.random() * 200 + 100;
        this.speed = Math.random() * 1 + 0.5;
        this.angle = -45 * (Math.PI / 180); // 45 degrees upwards
        this.opacity = Math.random() * 0.5 + 0.1;
        this.width = Math.random() * 2 + 1;
      }

      update() {
        this.x += Math.cos(this.angle) * this.speed;
        this.y += Math.sin(this.angle) * this.speed;
        this.opacity -= 0.003;

        if (this.opacity <= 0) {
          this.reset();
        }
      }

      draw(ctx: CanvasRenderingContext2D) {
        ctx.save();
        ctx.translate(this.x, this.y);
        ctx.rotate(this.angle);
        
        const gradient = ctx.createLinearGradient(0, 0, this.length, 0);
        gradient.addColorStop(0, `rgba(59, 130, 246, 0)`); // Blue
        gradient.addColorStop(0.5, `rgba(59, 130, 246, ${this.opacity})`);
        gradient.addColorStop(1, `rgba(59, 130, 246, 0)`);

        ctx.fillStyle = gradient;
        ctx.fillRect(0, -this.width / 2, this.length, this.width);
        ctx.restore();
      }

      reset() {
        this.x = Math.random() * canvas!.width + 200; // Start slightly off screen or scattered
        this.y = canvas!.height + 100; // Start from bottom
        this.opacity = Math.random() * 0.5 + 0.1;
        this.speed = Math.random() * 1 + 0.5;
      }
    }

    const init = () => {
      resize();
      for (let i = 0; i < numBeams; i++) {
        const beam = new Beam();
        beam.x = Math.random() * canvas.width;
        beam.y = Math.random() * canvas.height;
        beams.push(beam);
      }
    };

    const animate = () => {
      if (!ctx || !canvas) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      
      // Optional: Add a subtle grid background here if desired, 
      // but we'll keep it clean for "cooler" look.
      
      beams.forEach(beam => {
        beam.update();
        beam.draw(ctx);
      });

      animationFrameId = requestAnimationFrame(animate);
    };

    init();
    window.addEventListener("resize", resize);
    animate();

    return () => {
      window.removeEventListener("resize", resize);
      cancelAnimationFrame(animationFrameId);
    };
  }, []);

  return (
    <div className={cn("absolute inset-0 pointer-events-none overflow-hidden", className)}>
      {/* Dark gradient overlay for "high tech" feel */}
      <div className="absolute inset-0 bg-gradient-to-b from-background via-background/90 to-background/50 z-[1]" />
      <canvas
        ref={beamsRef}
        className="absolute inset-0 z-[0] opacity-60"
      />
    </div>
  );
};
