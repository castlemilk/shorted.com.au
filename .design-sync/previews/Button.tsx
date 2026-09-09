import * as React from "react";
import { Button } from "shorted";

/** The six variants, in the order buttonVariants declares them. */
export const Variants = () => (
  <div className="flex flex-wrap items-center gap-3">
    <Button variant="default">Track BHP</Button>
    <Button variant="secondary">Add to watchlist</Button>
    <Button variant="outline">Export CSV</Button>
    <Button variant="ghost">Dismiss</Button>
    <Button variant="destructive">Remove alert</Button>
    <Button variant="link">View ASIC filing</Button>
  </div>
);

/** The size scale. `icon` is square (h-10 w-10) for a bare glyph. */
export const Sizes = () => (
  <div className="flex flex-wrap items-center gap-3">
    <Button size="sm">Small</Button>
    <Button size="default">Default</Button>
    <Button size="lg">Large</Button>
    <Button size="icon" aria-label="Refresh">↻</Button>
  </div>
);

/** disabled drops to 50% opacity and kills pointer events. */
export const States = () => (
  <div className="flex flex-wrap items-center gap-3">
    <Button>Enabled</Button>
    <Button disabled>Disabled</Button>
    <Button variant="outline" disabled>Disabled outline</Button>
  </div>
);
