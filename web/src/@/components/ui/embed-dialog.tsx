"use client";

import React, { useMemo } from "react";
import { Code2 } from "lucide-react";

import { cn } from "~/@/lib/utils";
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
  DialogTrigger,
} from "~/@/components/ui/dialog";

export interface EmbedDialogProps {
  /** Which widget to build a snippet for. */
  target: EmbedTarget;
  /** Extra classes for the trigger button. */
  className?: string;
}

/**
 * "Embed this widget" affordance: a subtle toolbar button opening a dialog
 * with the copyable snippet. Snippet shape (figure + credit) and the reason
 * for it live in ~/@/lib/embed/snippet.
 */
export function EmbedDialog({ target, className }: EmbedDialogProps) {
  const snippet = useMemo(() => buildEmbedSnippet(target), [target]);
  const noun = embedNoun(target);

  return (
    <Dialog>
      <DialogTrigger asChild>
        <button
          type="button"
          title={`Embed this ${noun} on your site`}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground",
            className,
          )}
        >
          <Code2 className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">Embed</span>
          <span className="sr-only sm:hidden">Embed this {noun}</span>
        </button>
      </DialogTrigger>
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
          <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-lg bg-zinc-950 p-4 pr-12 font-mono text-xs leading-relaxed text-zinc-100">
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

export default EmbedDialog;
