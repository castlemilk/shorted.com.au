"use client";

import { ChevronDown, Wrench } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { Badge } from "~/@/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "~/@/components/ui/collapsible";
import { cn } from "~/@/lib/utils";

export type ToolStatus = "completed" | "failed";

export type ToolProps = ComponentProps<typeof Collapsible>;

/** One tool call the assistant made while answering. Collapsed by default. */
export function Tool({ className, ...props }: ToolProps) {
  return (
    <Collapsible
      className={cn(
        "w-full rounded-md border border-border/70 bg-background/60 text-xs",
        className,
      )}
      {...props}
    />
  );
}

export interface ToolHeaderProps
  extends Omit<ComponentProps<typeof CollapsibleTrigger>, "children"> {
  title: string;
  /** The tool's API name, shown in mono beside the title on wider screens. */
  toolName: string;
  status: ToolStatus;
}

export function ToolHeader({
  title,
  toolName,
  status,
  className,
  ...props
}: ToolHeaderProps) {
  const failed = status === "failed";
  return (
    <CollapsibleTrigger
      className={cn(
        "group flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
      {...props}
    >
      <Wrench aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate font-medium">{title}</span>
      <span className="hidden font-mono text-[10px] text-muted-foreground sm:inline">
        {toolName}
      </span>
      <Badge
        variant={failed ? "destructive" : "secondary"}
        className="shrink-0 text-[10px]"
      >
        {failed ? "Failed" : "Completed"}
      </Badge>
      <ChevronDown
        aria-hidden="true"
        className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180"
      />
    </CollapsibleTrigger>
  );
}

export type ToolContentProps = ComponentProps<typeof CollapsibleContent>;

export function ToolContent({ className, ...props }: ToolContentProps) {
  return (
    <CollapsibleContent
      className={cn("space-y-2 border-t border-border/70 px-2.5 py-2", className)}
      {...props}
    />
  );
}

function ToolSection({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <p className="text-[10px] font-medium text-muted-foreground">{label}</p>
      {children}
    </div>
  );
}

/** The arguments the tool was called with. */
export function ToolInput({ children }: { children: ReactNode }) {
  return <ToolSection label="Arguments">{children}</ToolSection>;
}

/** What the tool returned, or the error it reported. */
export function ToolOutput({
  children,
  errorText,
}: {
  children?: ReactNode;
  errorText?: string;
}) {
  if (!children && !errorText) return null;
  if (errorText) {
    return (
      <ToolSection label="Error">
        <p className="break-words text-destructive">{errorText}</p>
      </ToolSection>
    );
  }
  return <ToolSection label="Result">{children}</ToolSection>;
}
