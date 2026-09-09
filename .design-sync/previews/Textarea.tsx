import * as React from "react";
import { Textarea, Label } from "shorted";

export const Default = () => (
  <Textarea className="max-w-sm" placeholder="Add a note about this position…" />
);

export const WithLabel = () => (
  <div className="grid max-w-sm gap-2">
    <Label htmlFor="thesis">Thesis</Label>
    <Textarea id="thesis" defaultValue="Short interest has climbed four consecutive reports while the lithium spot price fell." />
  </div>
);

export const Disabled = () => <Textarea className="max-w-sm" placeholder="Read only" disabled />;
