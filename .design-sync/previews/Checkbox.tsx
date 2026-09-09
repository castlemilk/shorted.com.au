import * as React from "react";
import { Checkbox, Label } from "shorted";

/** The three static states. Radix drives `checked`; pass it to render one. */
export const States = () => (
  <div className="flex items-center gap-6">
    <Checkbox />
    <Checkbox checked />
    <Checkbox disabled />
  </div>
);

/** The idiomatic pairing — Checkbox + Label as one hit target. */
export const WithLabel = () => (
  <div className="grid gap-3">
    <div className="flex items-center gap-2">
      <Checkbox id="asx200" checked />
      <Label htmlFor="asx200">ASX 200 only</Label>
    </div>
    <div className="flex items-center gap-2">
      <Checkbox id="squeeze" />
      <Label htmlFor="squeeze">Squeeze candidates</Label>
    </div>
  </div>
);
