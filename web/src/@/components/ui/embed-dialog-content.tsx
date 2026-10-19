"use client";

import React, { forwardRef, useEffect, useMemo, useRef, useState } from "react";
import { Check, Code2, Copy, Download, FileCode, Share2 } from "lucide-react";

import { cn } from "~/@/lib/utils";
import { embedNoun, type EmbedTarget } from "~/@/lib/embed/snippet";
import {
  buildShareKit,
  isShareChannelId,
  type ShareChannel,
  type ShareChannelId,
} from "~/@/lib/embed/share";
import { BrandGlyph, isBrandGlyphId } from "~/@/components/ui/brand-glyphs";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "~/@/components/ui/dialog";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "~/@/components/ui/tabs";

export interface EmbedDialogContentProps {
  target: EmbedTarget;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** The channel a visitor picked last, so a regular sharer lands on theirs. */
const CHANNEL_KEY = "shorted:share-channel";

function readChannel(): ShareChannelId {
  try {
    const v = window.localStorage.getItem(CHANNEL_KEY);
    if (isShareChannelId(v)) return v;
  } catch {
    // storage blocked (private window, sandboxed frame): use the default
  }
  return "discord";
}

function writeChannel(id: ShareChannelId) {
  try {
    window.localStorage.setItem(CHANNEL_KEY, id);
  } catch {
    // not remembered; nothing else depends on it
  }
}

/**
 * The share page and its image live on this origin, but the kit's URLs are
 * absolute (they are pasted elsewhere). Load the preview, and download the
 * image, from the origin serving this page, so a preview deployment or a
 * local build shows its own render and `download` stays same-origin.
 */
function sameOrigin(url: string): string {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}`;
  } catch {
    return url;
  }
}

function ChannelIcon({ id }: { id: ShareChannelId }) {
  if (isBrandGlyphId(id)) return <BrandGlyph id={id} />;
  if (id === "markdown")
    return <FileCode aria-hidden className="h-3.5 w-3.5" />;
  return <Code2 aria-hidden className="h-3.5 w-3.5" />;
}

/** A labelled copy button that says when it worked. */
const CopyAction = forwardRef<
  HTMLButtonElement,
  { value: string; label?: string; className?: string }
>(function CopyAction({ value, label = "Copy", className }, ref) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");

  useEffect(() => {
    if (state === "idle") return;
    const t = setTimeout(() => setState("idle"), 2000);
    return () => clearTimeout(t);
  }, [state]);

  return (
    <button
      ref={ref}
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setState("copied");
        } catch {
          setState("failed");
        }
      }}
      className={cn(
        "inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-md border bg-background px-3 text-xs font-medium transition-colors hover:bg-muted",
        "[@media(pointer:coarse)]:min-h-11",
        className,
      )}
    >
      {state === "copied" ? (
        <Check aria-hidden className="h-3.5 w-3.5" />
      ) : (
        <Copy aria-hidden className="h-3.5 w-3.5" />
      )}
      <span aria-live="polite">
        {state === "copied"
          ? "Copied"
          : state === "failed"
            ? "Select and copy"
            : label}
      </span>
    </button>
  );
});

function ChannelPanel({ channel }: { channel: ShareChannel }) {
  return (
    <div className="space-y-2">
      <div className="relative rounded-lg border bg-muted/40">
        <pre
          className={cn(
            // Wrap a long URL anywhere: an unbroken one sets the dialog's
            // min-content width, and on a phone pushed it past the screen.
            "max-h-48 overflow-auto whitespace-pre-wrap p-3 pr-24 text-foreground [overflow-wrap:anywhere]",
            channel.code
              ? "font-mono text-xs leading-relaxed"
              : "font-sans text-sm leading-relaxed",
          )}
        >
          <code>{channel.text}</code>
        </pre>
        <CopyAction value={channel.text} className="absolute right-2 top-2" />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="min-w-0 flex-1 text-xs text-muted-foreground">
          {channel.hint}
        </p>
        {channel.intent && (
          <a
            href={channel.intent.href}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex min-h-9 items-center gap-1.5 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90 [@media(pointer:coarse)]:min-h-11"
          >
            <ChannelIcon id={channel.id} />
            {channel.intent.label}
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
        )}
      </div>
    </div>
  );
}

/**
 * The heavy half of the share affordance: Radix Dialog + Tabs.
 *
 * Split out and dynamically imported by EmbedDialog so it stays OUT of the
 * first-load bundle. Importing it eagerly cost /: +18kB, /statistics: +17kB
 * and /top: +14kB (CI bundle budget, 2026-07-28) for a button most visitors
 * never click, and the homepage budget has no headroom.
 *
 * What each channel copies, and why chat apps get a link rather than the
 * HTML snippet, lives in ~/@/lib/embed/share.
 */
export function EmbedDialogContent({
  target,
  open,
  onOpenChange,
}: EmbedDialogContentProps) {
  const kit = useMemo(() => buildShareKit(target), [target]);
  const noun = embedNoun(target);
  const [channel, setChannel] = useState<ShareChannelId>("discord");
  const [canShare, setCanShare] = useState(false);
  const [imageFailed, setImageFailed] = useState(false);
  const copyLinkRef = useRef<HTMLButtonElement>(null);

  // Read after mount: storage and navigator.share are browser-only.
  useEffect(() => {
    setChannel(readChannel());
    setCanShare(typeof navigator !== "undefined" && "share" in navigator);
  }, []);

  useEffect(() => setImageFailed(false), [kit.imageUrl]);

  const share = async () => {
    try {
      await navigator.share({ title: kit.headline, url: kit.url });
    } catch {
      // dismissed, or the platform refused: the copy buttons remain
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        // minmax(0,1fr): the grid's one column is the dialog's width, never
        // the widest unbreakable line inside it.
        className="max-h-[92dvh] max-w-2xl grid-cols-[minmax(0,1fr)] overflow-y-auto"
        // Focus the copy button, not the first field: a focused, selected
        // input raises the selection menu on a phone.
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          copyLinkRef.current?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>Share or embed this {noun}</DialogTitle>
          <DialogDescription>{kit.headline}. Updated daily.</DialogDescription>
        </DialogHeader>

        {kit.imageUrl && !imageFailed && (
          <figure className="space-y-1.5">
            {/* The card a pasted link turns into: the reader sees what they send. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={sameOrigin(kit.imageUrl)}
              alt={`Preview: ${kit.headline}`}
              width={1200}
              height={630}
              loading="lazy"
              onError={() => setImageFailed(true)}
              className="aspect-[1200/630] h-auto w-full rounded-lg border bg-muted object-cover"
            />
            <figcaption className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
              <span>The preview card a pasted link shows.</span>
              {kit.imageFileName && (
                <a
                  href={sameOrigin(kit.imageUrl)}
                  download={kit.imageFileName}
                  className="inline-flex min-h-8 items-center gap-1 rounded-md px-2 font-medium text-foreground hover:bg-muted"
                >
                  <Download aria-hidden className="h-3.5 w-3.5" />
                  Download image
                </a>
              )}
            </figcaption>
          </figure>
        )}

        <div className="space-y-1.5">
          <label
            htmlFor="share-link"
            className="text-xs font-medium text-muted-foreground"
          >
            Link
          </label>
          <div className="flex items-center gap-2">
            <input
              id="share-link"
              readOnly
              value={kit.url}
              onFocus={(e) => e.currentTarget.select()}
              className="h-9 min-w-0 flex-1 rounded-md border bg-muted/40 px-3 font-mono text-xs text-foreground [@media(pointer:coarse)]:h-11"
            />
            <CopyAction ref={copyLinkRef} value={kit.url} label="Copy link" />
            {canShare && (
              <button
                type="button"
                onClick={share}
                className="inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-md border bg-background px-3 text-xs font-medium transition-colors hover:bg-muted [@media(pointer:coarse)]:min-h-11"
              >
                <Share2 aria-hidden className="h-3.5 w-3.5" />
                Share
              </button>
            )}
          </div>
        </div>

        <Tabs
          value={channel}
          onValueChange={(v) => {
            if (!isShareChannelId(v)) return;
            setChannel(v);
            writeChannel(v);
          }}
        >
          <TabsList
            aria-label="Where are you sharing it?"
            className="flex h-auto w-full flex-wrap justify-start gap-1"
          >
            {kit.channels.map((c) => (
              <TabsTrigger
                key={c.id}
                value={c.id}
                className="min-h-8 gap-1.5 px-2.5 text-xs [@media(pointer:coarse)]:min-h-10"
              >
                <ChannelIcon id={c.id} />
                {c.label}
              </TabsTrigger>
            ))}
          </TabsList>
          {kit.channels.map((c) => (
            <TabsContent key={c.id} value={c.id} className="mt-3">
              <ChannelPanel channel={c} />
            </TabsContent>
          ))}
        </Tabs>

        <p className="text-xs text-muted-foreground">
          Free to share and embed. Please keep the credit to Shorted.com.au so
          readers can find the source data.
        </p>
      </DialogContent>
    </Dialog>
  );
}

export default EmbedDialogContent;
