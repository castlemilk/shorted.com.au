"use client";

import React, { useState } from "react";
import dynamic from "next/dynamic";
import { Share2 } from "lucide-react";

import { cn } from "~/@/lib/utils";
import { embedNoun, type EmbedTarget } from "~/@/lib/embed/snippet";

/**
 * Radix Dialog + Tabs are ~15-18kB of first-load JS. This affordance
 * lives on three STATIC pages (/, /statistics, /top) where almost no visitor
 * clicks it, and the homepage sits at its bundle ceiling — so the dialog is
 * mounted only after the first click, not imported with the page.
 */
const EmbedDialogContent = dynamic(
  () =>
    import("~/@/components/ui/embed-dialog-content").then(
      (m) => m.EmbedDialogContent,
    ),
  { ssr: false },
);

export interface EmbedDialogProps {
  /** Which widget to build a snippet for. */
  target: EmbedTarget;
  /** Extra classes for the trigger button. */
  className?: string;
}

/**
 * "Share or embed this widget" affordance: a link and ready-made copy for
 * Discord, Slack, X, LinkedIn, Reddit and Markdown (~/@/lib/embed/share), and
 * the website snippet (~/@/lib/embed/snippet), which explains its shape.
 */
export function EmbedDialog({ target, className }: EmbedDialogProps) {
  const [open, setOpen] = useState(false);
  // Keep the dialog mounted after first open so re-opening is instant.
  const [everOpened, setEverOpened] = useState(false);
  const noun = embedNoun(target);

  return (
    <>
      <button
        type="button"
        title={`Share or embed this ${noun}`}
        onClick={() => {
          setEverOpened(true);
          setOpen(true);
        }}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground",
          className,
        )}
      >
        <Share2 aria-hidden className="h-3.5 w-3.5" />
        <span className="hidden sm:inline">Share</span>
        <span className="sr-only sm:hidden">Share or embed this {noun}</span>
      </button>
      {everOpened && (
        <EmbedDialogContent
          target={target}
          open={open}
          onOpenChange={setOpen}
        />
      )}
    </>
  );
}

export default EmbedDialog;
