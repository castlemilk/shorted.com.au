import * as React from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
  Button,
  Input,
  Label,
  Badge,
} from "shorted";

/**
 * The canonical modal, forced `open` so it renders statically: header
 * (title + description), body, right-aligned footer, and the built-in
 * close affordance in the top-right corner.
 */
export const Default = () => (
  <Dialog open>
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Add BHP to a watchlist</DialogTitle>
        <DialogDescription>
          BHP Group · Materials · 0.82% of shares on issue held short.
        </DialogDescription>
      </DialogHeader>
      <p className="text-sm text-muted-foreground">
        Watchlisted stocks appear on your dashboard and are included in the
        Friday short-interest digest.
      </p>
      <DialogFooter>
        <Button variant="outline">Cancel</Button>
        <Button>Add to watchlist</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
);

/** A form modal — Label + Input inside the body, submit in the footer. */
export const WithForm = () => (
  <Dialog open>
    <DialogContent>
      <DialogHeader>
        <DialogTitle>New short interest alert</DialogTitle>
        <DialogDescription>
          Email me when the reported short position crosses a threshold.
        </DialogDescription>
      </DialogHeader>
      <div className="grid gap-4 py-2">
        <div className="grid gap-2">
          <Label htmlFor="dialog-ticker">ASX code</Label>
          <Input id="dialog-ticker" defaultValue="PLS" />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="dialog-threshold">Threshold (% of issue)</Label>
          <Input id="dialog-threshold" defaultValue="20.0" />
        </div>
      </div>
      <DialogFooter>
        <Button variant="outline">Cancel</Button>
        <Button>Create alert</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
);

/** A denser body: a data list rather than prose, with no footer actions. */
export const WithDataBody = () => (
  <Dialog open>
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Top shorted: 5 September 2026</DialogTitle>
        <DialogDescription>
          Percent of total product in issue, as reported to ASIC.
        </DialogDescription>
      </DialogHeader>
      <div className="divide-y text-sm">
        {[
          ["PLS", "Pilbara Minerals", "19.42%"],
          ["LTR", "Liontown Resources", "14.08%"],
          ["SYA", "Sayona Mining", "11.63%"],
          ["IEL", "IDP Education", "9.71%"],
        ].map(([code, name, pct]) => (
          <div key={code} className="flex items-center justify-between py-2">
            <span className="flex items-center gap-2">
              <Badge variant="outline">{code}</Badge>
              <span className="text-muted-foreground">{name}</span>
            </span>
            <span className="font-medium tabular-nums">{pct}</span>
          </div>
        ))}
      </div>
    </DialogContent>
  </Dialog>
);
