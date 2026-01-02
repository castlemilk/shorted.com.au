"use client";

import { cn } from "~/@/lib/utils";

interface GradientTextProps {
  children: React.ReactNode;
  className?: string;
  gradient?: string;
}

export function GradientText({
  children,
  className = "",
  gradient = "from-blue-500 via-purple-500 to-pink-500",
}: GradientTextProps) {
  return (
    <span
      className={cn(
        "bg-gradient-to-r bg-clip-text text-transparent animate-gradient bg-[length:200%_auto]",
        gradient,
        className
      )}
    >
      {children}
    </span>
  );
}

