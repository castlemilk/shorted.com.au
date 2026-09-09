import * as React from "react";
import { Label, Input, Checkbox, Switch } from "shorted";

/** The bare label at its default weight and size. */
export const Default = () => <Label>ASX code</Label>;

/** Stacked above the control it names — the standard field header. */
export const WithInput = () => (
  <div className="grid w-64 gap-2">
    <Label htmlFor="min-short">Minimum short interest</Label>
    <Input id="min-short" type="number" defaultValue={5} />
  </div>
);

/** Inline, trailing a checkbox or switch — the whole label is the hit target. */
export const Inline = () => (
  <div className="grid gap-3">
    <div className="flex items-center gap-2">
      <Checkbox id="asx200" defaultChecked />
      <Label htmlFor="asx200">ASX 200 only</Label>
    </div>
    <div className="flex items-center gap-2">
      <Switch id="weekly-digest" defaultChecked />
      <Label htmlFor="weekly-digest">Weekly digest</Label>
    </div>
  </div>
);

/** Label plus supporting copy — the description sits below, in muted text. */
export const WithDescription = () => (
  <div className="grid w-64 gap-2">
    <Label htmlFor="watchlist">Watchlist</Label>
    <Input id="watchlist" placeholder="BHP, PLS, CBA" />
    <p className="text-sm text-muted-foreground">
      Comma-separated ASX codes, up to 20.
    </p>
  </div>
);

/**
 * `peer-disabled` dimming: the label follows the control it labels, because
 * the control is marked `peer`.
 */
export const DisabledPeer = () => (
  <div className="flex items-center gap-2">
    <Checkbox id="director-trades" className="peer" disabled />
    <Label htmlFor="director-trades">Include director trades</Label>
  </div>
);
