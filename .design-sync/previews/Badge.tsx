import * as React from "react";
import { Badge } from "shorted";

/** The four variants. `default` is burnt amber; `outline` is text-only chrome. */
export const Variants = () => (
  <div className="flex flex-wrap items-center gap-2">
    <Badge variant="default">Shorted</Badge>
    <Badge variant="secondary">ASX 200</Badge>
    <Badge variant="destructive">Squeeze risk</Badge>
    <Badge variant="outline">Materials</Badge>
  </div>
);

/** Typical use: a dense row of metadata labels against a ticker. */
export const InContext = () => (
  <div className="flex flex-wrap items-center gap-2">
    <span className="text-sm font-semibold">PLS</span>
    <Badge variant="default">19.4% short</Badge>
    <Badge variant="secondary">Lithium</Badge>
    <Badge variant="outline">Reported 12 Sep</Badge>
  </div>
);
