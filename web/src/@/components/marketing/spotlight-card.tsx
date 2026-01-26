"use client";

import { useRef, useState, useEffect } from "react";
import { cn } from "~/@/lib/utils";

interface SpotlightCardProps {
  children: React.ReactNode;
  className?: string;
}

export function SpotlightCard({ children, className = "" }: SpotlightCardProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const [mousePosition, setMousePosition] = useState({ x: 0, y: 0 });
  const [isHovered, setIsHovered] = useState(false);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!cardRef.current) return;

      const rect = cardRef.current.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      setMousePosition({ x, y });
    };

    const card = cardRef.current;
    if (card) {
      card.addEventListener("mousemove", handleMouseMove);
      card.addEventListener("mouseenter", () => setIsHovered(true));
      card.addEventListener("mouseleave", () => setIsHovered(false));
    }

    return () => {
      if (card) {
        card.removeEventListener("mousemove", handleMouseMove);
        card.removeEventListener("mouseenter", () => setIsHovered(true));
        card.removeEventListener("mouseleave", () => setIsHovered(false));
      }
    };
  }, []);

  return (
    <div
      ref={cardRef}
      className={cn(
        "relative group rounded-xl border bg-card p-6 transition-all duration-300 overflow-hidden",
        "hover:shadow-2xl hover:shadow-blue-500/20",
        className
      )}
    >
      {/* Spotlight effect */}
      <div
        className={cn(
          "absolute inset-0 opacity-0 transition-opacity duration-300 pointer-events-none",
          isHovered && "opacity-100"
        )}
        style={{
          background: isHovered
            ? `radial-gradient(600px circle at ${mousePosition.x}px ${mousePosition.y}px, rgba(59, 130, 246, 0.15), transparent 40%)`
            : "transparent",
        }}
      />
      <div className="relative z-10">{children}</div>
    </div>
  );
}

