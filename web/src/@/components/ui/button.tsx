import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "~/@/lib/utils"

/**
 * Amber light as a response to state (DESIGN.md §4 Elevation).
 *
 * Base: focus-visible gets the `amber-glow` ring-plus-bloom on top of the
 * theme-split `--ring` (Burnt Amber on paper, Phosphor Amber on CRT black).
 * Tailwind composes ring and shadow into the same `box-shadow` stack, so the
 * 2px ring keeps its WCAG 2.4.11 job and the 30px bloom sits behind it. Focus
 * is singular by definition, so this can never stack into a second bloom.
 *
 * `default` (the Burnt Amber fill) is the only variant that lights on HOVER:
 * `amber-sm` is the vocabulary's "subtle hover lift on compact controls", and
 * it reads as the button's own amber warming under the pointer. Secondary is
 * avocado and outline/ghost are chrome — an amber halo on either would be
 * decoration, and decoration is prohibited.
 *
 * The transition list carries `box-shadow` so the glow arrives rather than
 * snapping; `prefers-reduced-motion` collapses it globally in globals.css.
 */
const buttonVariants = cva(
  "inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-[color,background-color,border-color,box-shadow] duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:shadow-amber-glow disabled:pointer-events-none disabled:opacity-50",
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
  }
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button"
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    )
  }
)
Button.displayName = "Button"

export { Button, buttonVariants }
