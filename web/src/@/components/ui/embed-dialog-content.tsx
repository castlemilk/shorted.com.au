"use client";

import React, { useMemo } from "react";

import { CopyButton } from "~/@/components/docs/copy-button";
import {
  buildEmbedSnippet,
  embedNoun,
  type EmbedTarget,
} from "~/@/lib/embed/snippet";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "~/@/components/ui/dialog";

export interface EmbedDialogContentProps {
  target: EmbedTarget;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * The heavy half of the embed affordance — Radix Dialog + CopyButton.
 *
 * Split out and dynamically imported by EmbedDialog so it stays OUT of the
 * first-load bundle. Importing it eagerly cost /: +18kB, /statistics: +17kB
 * and /top: +14kB (CI bundle budget, 2026-07-28) for a button most visitors
 * never click — and the homepage budget has no headroom.
 */
export function EmbedDialogContent({
  target,
  open,
  onOpenChange,
}: EmbedDialogContentProps) {
  const snippet = useMemo(() => buildEmbedSnippet(target), [target]);
  const noun = embedNoun(target);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Embed this {noun}</DialogTitle>
          <DialogDescription>
            Paste this snippet into any blog, forum post, or CMS. The {noun}{" "}
            updates daily from ASIC short position reports.
          </DialogDescription>
        </DialogHeader>
        <div className="group relative">
          <div className="absolute right-2 top-2">
            <CopyButton value={snippet.html} />
          </div>
          <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-lg bg-muted p-4 pr-12 font-mono text-xs leading-relaxed text-foreground">
            <code>{snippet.html}</code>
          </pre>
        </div>
        <p className="text-xs text-muted-foreground">
          Free to embed. The snippet includes a short credit line — please keep
          it so readers can find the source data.
        </p>
      </DialogContent>
    </Dialog>
  );
}

export default EmbedDialogContent;
