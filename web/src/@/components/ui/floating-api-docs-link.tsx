"use client";

import React from "react";
import Link from "next/link";
import { Terminal } from "lucide-react";
import { usePathname } from "next/navigation";
import { cn } from "~/@/lib/utils";

export function FloatingApiDocsLink() {
  const pathname = usePathname();

  // Don't show the bubble if we are already in the docs
  if (pathname.startsWith("/docs/api")) return null;

  return (
    <div className="fixed bottom-6 right-6 z-50 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <Link
        href="/docs/api"
        className={cn(
          "flex items-center gap-3 px-5 py-3.5 bg-zinc-950 dark:bg-white text-zinc-50 dark:text-zinc-950 rounded-full shadow-2xl shadow-blue-500/40 hover:scale-105 hover:shadow-blue-500/60 transition-all active:scale-95 group border border-zinc-800 dark:border-zinc-200",
        )}
      >
        <div className="relative flex h-2.5 w-2.5 mr-0.5">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75"></span>
          <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-blue-500"></span>
        </div>
        <Terminal className="h-4 w-4 transition-transform group-hover:-rotate-12" />
        <span className="text-[11px] font-extrabold tracking-widest uppercase">
          API Explorer
        </span>
      </Link>
    </div>
  );
}
