"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { X, Settings, Maximize2, Minimize2 } from "lucide-react";
import { type WidgetProps } from "@/types/dashboard";
import { useState, Suspense } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

interface WidgetWrapperProps extends WidgetProps {
  children: React.ReactNode;
  isEditMode?: boolean;
  isSelected?: boolean;
  onEdit?: () => void;
}

export function WidgetWrapper({
  config,
  children,
  isEditMode,
  isSelected,
  onRemove,
  onEdit,
  isLoading,
  error,
}: WidgetWrapperProps) {
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [dropdownOpen, setDropdownOpen] = useState(false);

  return (
    <Card
      className={`h-full transition-shadow hover:shadow-lg ${
        isEditMode ? "cursor-move" : ""
      } ${isSelected ? "ring-2 ring-primary" : ""} ${
        isFullscreen ? "fixed inset-4 z-50" : ""
      }`}
    >
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-medium">{config.title}</CardTitle>
          <div className="flex items-center gap-1">
            {!isEditMode && (
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6"
                onClick={() => setIsFullscreen(!isFullscreen)}
              >
                {isFullscreen ? (
                  <Minimize2 className="h-3 w-3" />
                ) : (
                  <Maximize2 className="h-3 w-3" />
                )}
              </Button>
            )}
            <DropdownMenu open={dropdownOpen} onOpenChange={setDropdownOpen}>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="h-6 w-6">
                  <Settings className="h-3 w-3" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem 
                  onClick={() => {
                    setDropdownOpen(false);
                    onEdit?.();
                  }}
                >
                  Configure Widget
                </DropdownMenuItem>
                {config.dataSource.refreshInterval && (
                  <DropdownMenuItem>
                    Refresh ({config.dataSource.refreshInterval}s)
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
            {isEditMode && onRemove && (
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6"
                onClick={onRemove}
              >
                <X className="h-3 w-3" />
              </Button>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="h-[calc(100%-4rem)] overflow-auto">
        {error ? (
          <div className="flex h-full items-center justify-center text-destructive">
            <p className="text-sm">Failed to load widget</p>
          </div>
        ) : isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-32 w-full" />
          </div>
        ) : (
          <Suspense
            fallback={
              <div className="space-y-2">
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-32 w-full" />
              </div>
            }
          >
            {children}
          </Suspense>
        )}
      </CardContent>
    </Card>
  );
}
