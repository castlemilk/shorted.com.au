import * as React from "react";
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
  Button,
  Label,
  Input,
  Separator,
  Badge,
} from "shorted";

/**
 * The canonical popover, forced `open` so the floating panel renders
 * statically: a trigger button with a `w-72` panel anchored below it.
 */
export const Default = () => (
  <div className="flex min-h-[22rem] justify-center p-8">
    <Popover open>
      <PopoverTrigger asChild>
        <Button variant="outline">Short position detail</Button>
      </PopoverTrigger>
      <PopoverContent>
        <div className="grid gap-3">
          <div>
            <h4 className="font-medium leading-none">PLS · 19.42%</h4>
            <p className="pt-1.5 text-sm text-muted-foreground">
              Of total product in issue, as reported to ASIC.
            </p>
          </div>
          <Separator />
          <dl className="grid grid-cols-2 gap-y-1.5 text-sm">
            <dt className="text-muted-foreground">Shares short</dt>
            <dd className="text-right tabular-nums">584.2m</dd>
            <dt className="text-muted-foreground">On issue</dt>
            <dd className="text-right tabular-nums">3.01b</dd>
            <dt className="text-muted-foreground">Report date</dt>
            <dd className="text-right tabular-nums">5 Sep 2026</dd>
          </dl>
        </div>
      </PopoverContent>
    </Popover>
  </div>
);

/** A form inside the panel — the common "quick settings" use. */
export const WithForm = () => (
  <div className="flex min-h-[22rem] justify-center p-8">
    <Popover open>
      <PopoverTrigger asChild>
        <Button variant="outline">Set alert</Button>
      </PopoverTrigger>
      <PopoverContent>
        <div className="grid gap-4">
          <div className="space-y-1">
            <h4 className="font-medium leading-none">Alert threshold</h4>
            <p className="text-sm text-muted-foreground">
              Notify me when LTR crosses this level.
            </p>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="popover-threshold">Short % of issue</Label>
            <Input id="popover-threshold" defaultValue="15.0" />
          </div>
          <Button size="sm">Save alert</Button>
        </div>
      </PopoverContent>
    </Popover>
  </div>
);

/** `align="end"` pins the panel's right edge to the trigger's right edge. */
export const AlignEnd = () => (
  <div className="flex min-h-[22rem] justify-end p-8">
    <Popover open>
      <PopoverTrigger asChild>
        <Button variant="outline">Sectors</Button>
      </PopoverTrigger>
      <PopoverContent align="end">
        <div className="grid gap-2 text-sm">
          <p className="font-medium leading-none">Filter by sector</p>
          {[
            ["Materials", "412"],
            ["Financials", "188"],
            ["Energy", "141"],
            ["Health Care", "203"],
          ].map(([sector, count]) => (
            <div key={sector} className="flex items-center justify-between">
              <span className="text-muted-foreground">{sector}</span>
              <Badge variant="secondary">{count}</Badge>
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  </div>
);
