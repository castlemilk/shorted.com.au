import * as React from "react";
import { Input, Label } from "shorted";

/** Bare input at its default width. */
export const Default = () => <Input placeholder="Search ASX code or company" className="max-w-sm" />;

/** The idiomatic pairing — Label + Input in a field stack. */
export const WithLabel = () => (
  <div className="grid max-w-sm gap-2">
    <Label htmlFor="ticker">Ticker</Label>
    <Input id="ticker" placeholder="BHP" />
  </div>
);

/** States that render statically. */
export const States = () => (
  <div className="grid max-w-sm gap-3">
    <Input defaultValue="PLS" />
    <Input placeholder="Disabled" disabled />
    <Input type="number" defaultValue={19.4} />
  </div>
);
