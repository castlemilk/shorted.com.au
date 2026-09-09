import * as React from "react";
import { Switch, Label } from "shorted";

/** Both states side by side — off is the default. */
export const Default = () => (
  <div className="flex items-center gap-4">
    <Switch />
    <Switch defaultChecked />
  </div>
);

/** The idiomatic pairing: Switch + Label, wired by `id`/`htmlFor`. */
export const WithLabel = () => (
  <div className="flex items-center gap-3">
    <Switch id="only-shorted" defaultChecked />
    <Label htmlFor="only-shorted">Only shorted stocks</Label>
  </div>
);

/** Disabled in both positions — a setting the current plan cannot change. */
export const Disabled = () => (
  <div className="flex items-center gap-4">
    <Switch disabled />
    <Switch disabled defaultChecked />
  </div>
);

/** A settings block: label, supporting copy, switch on the trailing edge. */
export const SettingsRows = () => (
  <div className="grid w-80 gap-4">
    <div className="flex items-start justify-between gap-4">
      <div className="grid gap-1">
        <Label htmlFor="alert-asic">ASIC report alerts</Label>
        <p className="text-sm text-muted-foreground">
          Email me when a new daily short position report lands.
        </p>
      </div>
      <Switch id="alert-asic" defaultChecked />
    </div>
    <div className="flex items-start justify-between gap-4">
      <div className="grid gap-1">
        <Label htmlFor="alert-squeeze">Squeeze candidates</Label>
        <p className="text-sm text-muted-foreground">
          Notify me when short interest crosses 15% of issue.
        </p>
      </div>
      <Switch id="alert-squeeze" />
    </div>
  </div>
);
