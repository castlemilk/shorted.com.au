"use client";

import type { ComponentProps } from "react";
import { Button } from "~/@/components/ui/button";
import { cn } from "~/@/lib/utils";

export type SuggestionsProps = ComponentProps<"div">;

/** A wrapping row of suggested prompts. It wraps rather than scrolls sideways. */
export function Suggestions({ className, ...props }: SuggestionsProps) {
  return <div className={cn("flex flex-wrap gap-2", className)} {...props} />;
}

export type SuggestionProps = Omit<ComponentProps<typeof Button>, "onClick"> & {
  suggestion: string;
  onClick?: (suggestion: string) => void;
};

/** One suggested prompt. Clicking it hands its text to `onClick`. */
export function Suggestion({
  suggestion,
  onClick,
  className,
  children,
  ...props
}: SuggestionProps) {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className={cn(
        "h-auto whitespace-normal px-3 py-1.5 text-left text-xs",
        className,
      )}
      onClick={() => onClick?.(suggestion)}
      {...props}
    >
      {children ?? suggestion}
    </Button>
  );
}
