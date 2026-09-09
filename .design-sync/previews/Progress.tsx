import * as React from "react";
import { Progress } from "shorted";

/** The fill scale. `value` is 0–100. */
export const Scale = () => (
  <div className="grid max-w-sm gap-3">
    <Progress value={0} />
    <Progress value={35} />
    <Progress value={72} />
    <Progress value={100} />
  </div>
);

/** Typical use: short interest as a proportion of shares on issue. */
export const InContext = () => (
  <div className="grid max-w-sm gap-2">
    <div className="flex items-baseline justify-between text-sm">
      <span className="font-semibold">PLS</span>
      <span className="text-muted-foreground">19.4% short</span>
    </div>
    <Progress value={19.4} />
  </div>
);
