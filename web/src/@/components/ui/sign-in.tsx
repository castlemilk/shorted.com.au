"use client";

import { signInAction } from "~/app/actions/auth";
import { cn } from "~/@/lib/utils";
import { type VariantProps, cva } from "class-variance-authority";

const signInButtonVariants = cva(
  "inline-flex items-center justify-center rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90",
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
          "font-bold transition-all hover:scale-105 active:scale-95 px-5 shadow-sm shadow-blue-500/20",
          className,
        )}
      >
        Sign in
      </button>
    </form>
  );
}
