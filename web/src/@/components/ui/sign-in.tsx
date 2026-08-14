"use client";

import { signInAction } from "~/app/actions/auth";
import { cn } from "~/@/lib/utils";
import { type VariantProps, cva } from "class-variance-authority";

// NOTE: a standalone fork of `buttonVariants` (button.tsx), kept so this
// server-action form stays independent of the Button component. It therefore
// has to mirror the Button's elevation contract by hand: the amber
// ring-plus-bloom on focus-visible, and hover-only glow on the primary fill.
const signInButtonVariants = cva(
  "inline-flex items-center justify-center rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:shadow-amber-glow disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground hover:bg-primary/90 hover:shadow-amber-sm",
        destructive:
          "bg-destructive text-destructive-foreground hover:bg-destructive/90",
        outline:
          "border border-input bg-background hover:bg-accent hover:text-accent-foreground",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-10 px-4 py-2",
        sm: "h-9 rounded-md px-3",
        lg: "h-11 rounded-md px-8",
        icon: "h-10 w-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

interface SignInProps extends VariantProps<typeof signInButtonVariants> {
  className?: string;
}

export function SignIn({
  variant = "default",
  size = "sm",
  className,
}: SignInProps = {}) {
  return (
    <form action={signInAction}>
      <button
        type="submit"
        className={cn(
          signInButtonVariants({ variant, size }),
          // Names the properties because this overrides the variant's
          // `transition-colors`: the press/lift needs transform, the variant
          // still needs its hover fill, and box-shadow carries the glow.
          // No resting shadow — this is the most-seen control in the product
          // and a glow left switched on at rest is decoration (DESIGN.md §4).
          // It is already the brightest thing in the header; amber answers
          // the pointer via the variant's `hover:shadow-amber-sm`.
          "font-bold transition-[transform,background-color,color,box-shadow] duration-200 ease-out hover:scale-105 active:scale-95 px-5",
          className,
        )}
      >
        Sign in
      </button>
    </form>
  );
}
