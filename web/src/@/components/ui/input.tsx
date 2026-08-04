import * as React from "react";

import { cn } from "~/@/lib/utils";

export type InputProps = React.InputHTMLAttributes<HTMLInputElement>;

/**
 * "The focus ring is the glow" (DESIGN.md §5 Inputs), made literal: the 2px
 * theme-split `--ring` still carries the WCAG 1.4.11 / 2.4.11 contrast, and
 * `amber-glow` adds the bloom behind it. Flat at every other moment — the
 * heavier `--input` boundary is what identifies the field at rest.
 */
const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background transition-shadow duration-200 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:shadow-amber-glow disabled:cursor-not-allowed disabled:opacity-50",
          className,
        )}
        ref={ref}
        {...props}
      />
    );
  },
);
Input.displayName = "Input";

export { Input };
