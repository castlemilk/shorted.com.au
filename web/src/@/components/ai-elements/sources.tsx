"use client";

import { ChevronDown, ExternalLink, Link2 } from "lucide-react";
import type { ComponentProps } from "react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "~/@/components/ui/collapsible";
import { cn } from "~/@/lib/utils";

export type SourcesProps = ComponentProps<typeof Collapsible>;

/** The citations behind an answer, collapsed by default. */
export function Sources({ className, ...props }: SourcesProps) {
  return <Collapsible className={cn("w-full text-xs", className)} {...props} />;
}

export interface SourcesTriggerProps
  extends Omit<ComponentProps<typeof CollapsibleTrigger>, "children"> {
  count: number;
}

export function SourcesTrigger({ count, className, ...props }: SourcesTriggerProps) {
  return (
    <CollapsibleTrigger
      className={cn(
        "group inline-flex items-center gap-1.5 rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
      {...props}
    >
      <Link2 aria-hidden="true" className="h-3 w-3" />
      <span>{count === 1 ? "1 source" : `${count} sources`}</span>
      <ChevronDown
        aria-hidden="true"
        className="h-3 w-3 transition-transform group-data-[state=open]:rotate-180"
      />
    </CollapsibleTrigger>
  );
}

export type SourcesContentProps = ComponentProps<typeof CollapsibleContent>;

export function SourcesContent({ className, ...props }: SourcesContentProps) {
  return (
    <CollapsibleContent
      className={cn("mt-1.5 flex flex-col gap-1", className)}
      {...props}
    />
  );
}

export interface SourceProps extends Omit<ComponentProps<"a">, "href" | "title"> {
  /** Only an absolute http(s) URL is a link; without one the source is text. */
  href?: string;
  title: string;
  subtitle?: string;
}

export function Source({ href, title, subtitle, className, ...props }: SourceProps) {
  const body = (
    <>
      <span className="min-w-0 flex-1 truncate">{title}</span>
      {subtitle && (
        <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">
          {subtitle}
        </span>
      )}
    </>
  );

  if (!href) {
    return (
      <span
        className={cn(
          "flex items-center gap-2 rounded-sm px-2 py-1 text-muted-foreground",
          className,
        )}
      >
        {body}
      </span>
    );
  }

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        "flex items-center gap-2 rounded-sm px-2 py-1 text-primary underline-offset-2 hover:bg-muted hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
      {...props}
    >
      {body}
      <ExternalLink aria-hidden="true" className="h-3 w-3 shrink-0" />
      <span className="sr-only">(opens in a new tab)</span>
    </a>
  );
}
