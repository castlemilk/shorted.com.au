"use client";

import { useState } from "react";
import { Check, Copy, Download, FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MarkdownPreview } from "./markdown-preview";

/**
 * One private doc with the controls an operator needs: copy the whole document
 * as markdown (to paste into a workflow's prompt or a tool's config), download
 * it as a .md file, and read it rendered or as the raw markdown.
 */
export interface PrivateDocViewerProps {
  slug: string;
  title: string;
  description: string;
  markdown: string;
}

export function PrivateDocViewer({ slug, title, description, markdown }: PrivateDocViewerProps) {
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const [view, setView] = useState<"rendered" | "markdown">("rendered");
  const [open, setOpen] = useState(slug === "market-moves");

  async function onCopy() {
    try {
      await navigator.clipboard.writeText(markdown);
      setCopied(true);
      setCopyFailed(false);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopyFailed(true);
      setView("markdown");
      setOpen(true);
    }
  }

  function onDownload() {
    const url = URL.createObjectURL(new Blob([markdown], { type: "text/markdown;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `shorted-${slug}.md`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const lines = markdown.split("\n").length;

  return (
    <section id={slug} aria-labelledby={`${slug}-title`} className="scroll-mt-24 rounded-xl border bg-card">
      <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h2 id={`${slug}-title`} className="flex items-center gap-2 text-lg font-semibold">
            <FileText className="h-4 w-4 shrink-0" aria-hidden />
            {title}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
          <p className="mt-1 text-xs text-muted-foreground">{lines.toLocaleString("en-AU")} lines of markdown</p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <Button type="button" onClick={onCopy} className="gap-1.5">
            {copied ? <Check className="h-4 w-4" aria-hidden /> : <Copy className="h-4 w-4" aria-hidden />}
            {copied ? "Copied" : "Copy markdown"}
          </Button>
          <Button type="button" variant="outline" onClick={onDownload} className="gap-1.5">
            <Download className="h-4 w-4" aria-hidden />
            Download .md
          </Button>
        </div>
      </div>
      {copyFailed ? (
        <p role="alert" className="px-4 pb-2 text-sm text-destructive">
          Copying failed; the markdown is shown below to select and copy by hand.
        </p>
      ) : null}
      <div className="border-t px-4 py-2">
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" size="sm" variant="ghost" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
            {open ? "Hide" : "Show"} document
          </Button>
          {open ? (
            <div role="group" aria-label="View" className="inline-flex rounded-md border p-0.5">
              {(["rendered", "markdown"] as const).map((v) => (
                <Button
                  key={v}
                  type="button"
                  size="sm"
                  variant={view === v ? "secondary" : "ghost"}
                  aria-pressed={view === v}
                  onClick={() => setView(v)}
                >
                  {v === "rendered" ? "Rendered" : "Markdown"}
                </Button>
              ))}
            </div>
          ) : null}
        </div>
        {open ? (
          <div className="mt-2 max-h-[70vh] overflow-auto rounded-md border bg-background p-4">
            {view === "rendered" ? (
              <MarkdownPreview markdown={markdown} />
            ) : (
              <pre data-testid={`${slug}-markdown`} className="select-all whitespace-pre-wrap break-words font-mono text-xs leading-relaxed">
                {markdown}
              </pre>
            )}
          </div>
        ) : null}
      </div>
    </section>
  );
}
