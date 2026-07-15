"use client";

import React, { useMemo } from "react";
import { Code2 } from "lucide-react";

import { cn } from "~/@/lib/utils";
import { siteConfig } from "~/@/config/site";
import { CopyButton } from "~/@/components/docs/copy-button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "~/@/components/ui/dialog";

/**
 * Build the iframe snippet for the public /embed/chart widget.
 *
 * The embed route (web/src/app/embed/chart/page.tsx) accepts a single query
 * param — `code` (ASX ticker, upper-cased server-side). Period selection is
 * interactive inside the embed itself, so no period param exists.
 */
export function buildEmbedSnippet(stockCode: string): string {
  const code = stockCode.toUpperCase();
  const src = `${siteConfig.url}/embed/chart?code=${encodeURIComponent(code)}`;
  return `<iframe src="${src}" width="100%" height="480" frameborder="0" title="${code} short interest — Shorted.com.au"></iframe>`;
}

export interface EmbedChartDialogProps {
  /** ASX stock code the snippet should point at, e.g. "BHP". */
  stockCode: string;
  /** Extra classes for the trigger button. */
  className?: string;
}

/**
 * "Embed this chart" affordance: a subtle toolbar button that opens a dialog
 * with a copyable iframe snippet for the public /embed/chart widget.
 * Free to embed with attribution to Shorted.com.au.
 */
export function EmbedChartDialog({ stockCode, className }: EmbedChartDialogProps) {
  const snippet = useMemo(() => buildEmbedSnippet(stockCode), [stockCode]);

  return (
    <Dialog>
      <DialogTrigger asChild>
        <button
          type="button"
          title="Embed this chart on your site"
          className={cn(
            "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground",
            className,
          )}
        >
          <Code2 className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">Embed</span>
          <span className="sr-only sm:hidden">Embed this chart</span>
        </button>
      </DialogTrigger>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Embed this chart</DialogTitle>
          <DialogDescription>
            Paste this snippet into any blog, forum post, or CMS to embed a
            live {stockCode.toUpperCase()} short interest chart.
          </DialogDescription>
        </DialogHeader>
        <div className="group relative">
          <div className="absolute right-2 top-2">
            <CopyButton value={snippet} />
          </div>
          <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-lg bg-zinc-950 p-4 pr-12 font-mono text-xs leading-relaxed text-zinc-100">
            <code>{snippet}</code>
          </pre>
        </div>
        <p className="text-xs text-muted-foreground">
          Free to embed with attribution to Shorted.com.au. The chart updates
          daily from ASIC short position reports.
        </p>
      </DialogContent>
    </Dialog>
  );
}

export default EmbedChartDialog;
