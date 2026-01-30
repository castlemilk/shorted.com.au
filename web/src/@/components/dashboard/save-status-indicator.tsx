"use client";

import { type SaveStatus } from "@/types/dashboard";
import { Loader2, Check, AlertCircle, Cloud, CloudOff } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";

interface SaveStatusIndicatorProps {
  status: SaveStatus;
  lastSavedAt?: Date | null;
  error?: string | null;
  isOnline?: boolean;
  onRetry?: () => void;
  className?: string;
}

export function SaveStatusIndicator({
  status,
  lastSavedAt,
  error,
  isOnline = true,
  onRetry,
  className,
}: SaveStatusIndicatorProps) {
  const formatLastSaved = (date: Date) => {
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffSec = Math.floor(diffMs / 1000);
    const diffMin = Math.floor(diffSec / 60);
    const diffHour = Math.floor(diffMin / 60);

    if (diffSec < 10) return "just now";
    if (diffSec < 60) return `${diffSec}s ago`;
    if (diffMin < 60) return `${diffMin}m ago`;
    if (diffHour < 24) return `${diffHour}h ago`;
    return date.toLocaleDateString();
  };

  const renderContent = () => {
    switch (status) {
      case "pending":
        return (
          <div className="flex items-center gap-1.5 text-muted-foreground">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-yellow-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-yellow-500" />
            </span>
            <span className="text-xs">Unsaved</span>
          </div>
        );

      case "saving":
        return (
          <div className="flex items-center gap-1.5 text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
            <span className="text-xs">Saving...</span>
          </div>
        );

      case "saved":
        return (
          <div className="flex items-center gap-1.5 text-green-600 dark:text-green-500">
            <Check className="h-3 w-3" />
            <span className="text-xs">Saved</span>
          </div>
        );

      case "error":
        return (
          <div className="flex items-center gap-1.5 text-destructive">
            <AlertCircle className="h-3 w-3" />
            <span className="text-xs">Save failed</span>
            {onRetry && (
              <Button
                variant="ghost"
                size="sm"
                className="h-5 px-1.5 text-xs"
                onClick={onRetry}
              >
                Retry
              </Button>
            )}
          </div>
        );

      case "offline":
        return (
          <div className="flex items-center gap-1.5 text-orange-500">
            <CloudOff className="h-3 w-3" />
            <span className="text-xs">Offline</span>
          </div>
        );

      case "idle":
      default:
        if (!isOnline) {
          return (
            <div className="flex items-center gap-1.5 text-orange-500">
              <CloudOff className="h-3 w-3" />
              <span className="text-xs">Offline</span>
            </div>
          );
        }
        if (lastSavedAt) {
          return (
            <div className="flex items-center gap-1.5 text-muted-foreground">
              <Cloud className="h-3 w-3" />
              <span className="text-xs">Saved {formatLastSaved(lastSavedAt)}</span>
            </div>
          );
        }
        return null;
    }
  };

  const content = renderContent();
  if (!content) return null;

  const tooltipContent = () => {
    if (status === "error" && error) {
      return error;
    }
    if (status === "offline") {
      return "Changes will sync when you're back online";
    }
    if (status === "pending") {
      return "Changes will be saved automatically";
    }
    if (lastSavedAt) {
      return `Last saved: ${lastSavedAt.toLocaleString()}`;
    }
    return null;
  };

  const tooltip = tooltipContent();

  if (tooltip) {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <div className={cn("cursor-default", className)}>{content}</div>
          </TooltipTrigger>
          <TooltipContent>
            <p className="text-xs">{tooltip}</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  return <div className={className}>{content}</div>;
}
