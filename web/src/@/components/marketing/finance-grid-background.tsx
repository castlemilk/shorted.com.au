"use client";

import { cn } from "~/@/lib/utils";

interface FinanceGridBackgroundProps {
  className?: string;
}

/**
 * A distinctive geometric grid background with animated elements
 * Inspired by financial trading interfaces and data visualization
 * Uses pure CSS animations for performance and offline support
 */
export function FinanceGridBackground({ className }: FinanceGridBackgroundProps) {
  return (
    <div className={cn("absolute inset-0 overflow-hidden", className)}>
      {/* Base gradient */}
      <div className="absolute inset-0 bg-gradient-to-b from-background via-background to-background/95" />
      
      {/* Grid pattern */}
      <svg
        className="absolute inset-0 w-full h-full opacity-[0.03] dark:opacity-[0.05]"
        xmlns="http://www.w3.org/2000/svg"
      >
        <defs>
          <pattern
            id="finance-grid"
            width="60"
            height="60"
            patternUnits="userSpaceOnUse"
          >
            <path
              d="M 60 0 L 0 0 0 60"
              fill="none"
              stroke="currentColor"
              strokeWidth="1"
            />
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#finance-grid)" />
      </svg>

      {/* Animated diagonal lines - using theme colors */}
      <div className="absolute inset-0 overflow-hidden">
        {/* Rising line 1 - secondary (avocado/sage) */}
        <div
          className="absolute w-px h-[200px] bg-gradient-to-t from-transparent via-secondary/40 to-transparent"
          style={{ left: "15%", animation: "grid-rise-line 8s ease-in-out infinite", animationDelay: "0s" }}
        />
        {/* Rising line 2 */}
        <div
          className="absolute w-px h-[150px] bg-gradient-to-t from-transparent via-secondary/30 to-transparent"
          style={{ left: "35%", animation: "grid-rise-line 8s ease-in-out infinite", animationDelay: "2s" }}
        />
        {/* Falling line 1 - accent (rust/tawny) */}
        <div
          className="absolute w-px h-[180px] bg-gradient-to-b from-transparent via-accent/40 to-transparent"
          style={{ left: "55%", animation: "grid-fall-line 8s ease-in-out infinite", animationDelay: "1s" }}
        />
        {/* Rising line 3 */}
        <div
          className="absolute w-px h-[160px] bg-gradient-to-t from-transparent via-secondary/25 to-transparent"
          style={{ left: "75%", animation: "grid-rise-line 8s ease-in-out infinite", animationDelay: "3s" }}
        />
        {/* Falling line 2 */}
        <div
          className="absolute w-px h-[140px] bg-gradient-to-b from-transparent via-accent/30 to-transparent"
          style={{ left: "90%", animation: "grid-fall-line 8s ease-in-out infinite", animationDelay: "2.5s" }}
        />
      </div>

      {/* Accent dots grid */}
      <div className="absolute inset-0">
        <div className="absolute top-1/4 left-1/4 w-2 h-2 rounded-full bg-secondary/20" style={{ animation: "grid-pulse-slow 4s ease-in-out infinite" }} />
        <div className="absolute top-1/3 right-1/3 w-1.5 h-1.5 rounded-full bg-primary/20" style={{ animation: "grid-pulse-slow 4s ease-in-out infinite", animationDelay: "1s" }} />
        <div className="absolute bottom-1/4 left-1/3 w-2 h-2 rounded-full bg-accent/20" style={{ animation: "grid-pulse-slow 4s ease-in-out infinite", animationDelay: "2s" }} />
        <div className="absolute top-2/3 right-1/4 w-1.5 h-1.5 rounded-full bg-primary/20" style={{ animation: "grid-pulse-slow 4s ease-in-out infinite", animationDelay: "0.5s" }} />
      </div>

      {/* Horizontal data streams */}
      <div className="absolute inset-0 overflow-hidden opacity-30">
        <div
          className="absolute h-px w-[300px] bg-gradient-to-r from-transparent via-primary/50 to-transparent"
          style={{ top: "20%", animation: "grid-stream-left 12s linear infinite", animationDelay: "0s" }}
        />
        <div
          className="absolute h-px w-[200px] bg-gradient-to-r from-transparent via-secondary/40 to-transparent"
          style={{ top: "40%", animation: "grid-stream-right 12s linear infinite", animationDelay: "1.5s" }}
        />
        <div
          className="absolute h-px w-[250px] bg-gradient-to-r from-transparent via-accent/40 to-transparent"
          style={{ top: "60%", animation: "grid-stream-left 12s linear infinite", animationDelay: "3s" }}
        />
        <div
          className="absolute h-px w-[180px] bg-gradient-to-r from-transparent via-primary/30 to-transparent"
          style={{ top: "80%", animation: "grid-stream-right 12s linear infinite", animationDelay: "2s" }}
        />
      </div>

      {/* Corner accent gradients */}
      <div className="absolute top-0 left-0 w-1/3 h-1/3 bg-gradient-to-br from-primary/5 to-transparent" />
      <div className="absolute bottom-0 right-0 w-1/3 h-1/3 bg-gradient-to-tl from-secondary/5 to-transparent" />

      {/* Global styles for animations */}
      <style dangerouslySetInnerHTML={{ __html: `
        @keyframes grid-rise-line {
          0% { transform: translateY(100vh); opacity: 0; }
          10% { opacity: 1; }
          90% { opacity: 1; }
          100% { transform: translateY(-100%); opacity: 0; }
        }
        
        @keyframes grid-fall-line {
          0% { transform: translateY(-100%); opacity: 0; }
          10% { opacity: 1; }
          90% { opacity: 1; }
          100% { transform: translateY(100vh); opacity: 0; }
        }
        
        @keyframes grid-stream-left {
          0% { transform: translateX(100vw); opacity: 0; }
          10% { opacity: 1; }
          90% { opacity: 1; }
          100% { transform: translateX(-100%); opacity: 0; }
        }
        
        @keyframes grid-stream-right {
          0% { transform: translateX(-100%); opacity: 0; }
          10% { opacity: 1; }
          90% { opacity: 1; }
          100% { transform: translateX(100vw); opacity: 0; }
        }
        
        @keyframes grid-pulse-slow {
          0%, 100% { opacity: 0.2; transform: scale(1); }
          50% { opacity: 0.6; transform: scale(1.5); }
        }
      `}} />
    </div>
  );
}

