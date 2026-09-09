import * as React from "react";
import { Toggle } from "shorted";

/** The two variants, off and on. */
export const Variants = () => (
  <div className="flex items-center gap-3">
    <Toggle>Default</Toggle>
    <Toggle pressed>Default on</Toggle>
    <Toggle variant="outline">Outline</Toggle>
    <Toggle variant="outline" pressed>Outline on</Toggle>
  </div>
);

/** The size scale. Shown on `outline` because a Toggle at rest is chromeless —
 *  on the default variant the sizes are invisible until hover or pressed. */
export const Sizes = () => (
  <div className="flex items-center gap-3">
    <Toggle variant="outline" size="sm">Small</Toggle>
    <Toggle variant="outline" size="default">Default</Toggle>
    <Toggle variant="outline" size="lg">Large</Toggle>
  </div>
);
