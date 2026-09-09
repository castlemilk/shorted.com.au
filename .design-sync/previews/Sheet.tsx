import * as React from "react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetFooter,
  SheetTitle,
  SheetDescription,
  Button,
  Label,
  Input,
  Separator,
} from "shorted";

/**
 * The default side (`right`) — the canonical filter panel, forced `open`
 * so the panel renders statically.
 */
export const Right = () => (
  <Sheet open>
    <SheetContent side="right">
      <SheetHeader>
        <SheetTitle>Screener filters</SheetTitle>
        <SheetDescription>
          Narrow the 2,143 ASX products currently reporting to ASIC.
        </SheetDescription>
      </SheetHeader>
      <div className="grid gap-4 py-6">
        <div className="grid gap-2">
          <Label htmlFor="sheet-min">Minimum short %</Label>
          <Input id="sheet-min" defaultValue="5.0" />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="sheet-sector">Sector</Label>
          <Input id="sheet-sector" defaultValue="Materials" />
        </div>
        <Separator />
        <p className="text-sm text-muted-foreground">
          412 products match these filters.
        </p>
      </div>
      <SheetFooter>
        <Button variant="outline">Reset</Button>
        <Button>Apply filters</Button>
      </SheetFooter>
    </SheetContent>
  </Sheet>
);

/** `side="left"` — the navigation drawer form. */
export const Left = () => (
  <Sheet open>
    <SheetContent side="left">
      <SheetHeader>
        <SheetTitle>Shorted</SheetTitle>
        <SheetDescription>ASX short selling, tracked daily.</SheetDescription>
      </SheetHeader>
      <nav className="grid gap-1 py-6 text-sm">
        {[
          "Top shorted",
          "Screener",
          "Industry treemap",
          "Weekly reports",
          "Housing",
          "Economy",
        ].map((item) => (
          <a
            key={item}
            href="#"
            className="rounded-md px-2 py-2 text-foreground hover:bg-accent"
          >
            {item}
          </a>
        ))}
      </nav>
    </SheetContent>
  </Sheet>
);

/** `side="bottom"` — the mobile detail summary, full-bleed across the base. */
export const Bottom = () => (
  <Sheet open>
    <SheetContent side="bottom">
      <SheetHeader>
        <SheetTitle>PLS · Pilbara Minerals</SheetTitle>
        <SheetDescription>
          Materials · Lithium · ASIC report 5 September 2026
        </SheetDescription>
      </SheetHeader>
      <div className="grid grid-cols-3 gap-4 py-6 text-sm">
        <div>
          <div className="text-muted-foreground">Short position</div>
          <div className="text-2xl font-semibold tabular-nums">19.42%</div>
        </div>
        <div>
          <div className="text-muted-foreground">Change (3m)</div>
          <div className="text-2xl font-semibold tabular-nums">+2.8pp</div>
        </div>
        <div>
          <div className="text-muted-foreground">Days to cover</div>
          <div className="text-2xl font-semibold tabular-nums">6.4</div>
        </div>
      </div>
    </SheetContent>
  </Sheet>
);

/** `side="top"` — used for system-wide notices that need an acknowledgement. */
export const Top = () => (
  <Sheet open>
    <SheetContent side="top">
      <SheetHeader>
        <SheetTitle>Data notice</SheetTitle>
        <SheetDescription>
          ASIC has restated short positions for 14 products for the week ending
          29 August 2026. Charts have been backfilled.
        </SheetDescription>
      </SheetHeader>
      <SheetFooter className="pt-6">
        <Button variant="outline">View restated products</Button>
        <Button>Dismiss</Button>
      </SheetFooter>
    </SheetContent>
  </Sheet>
);
