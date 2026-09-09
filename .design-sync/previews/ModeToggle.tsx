import * as React from "react";
import { ModeToggle, Button, Card, CardHeader, CardTitle, CardDescription, CardContent, Badge } from "shorted";

/**
 * The control itself: a 36px ghost trigger holding a sun and a moon glyph
 * stacked. Only one is scaled in at a time — the sun in light, the moon in
 * dark — so the button never changes size when the theme flips. The menu
 * (Light / Dark / System) opens on click into a portal.
 */
export const Default = () => (
  <div className="inline-flex w-fit items-center gap-3 rounded-md border border-border p-3">
    <ModeToggle />
    <span className="text-xs text-muted-foreground">Toggle theme</span>
  </div>
);

/** Where it actually lives: the far right of the site header. */
export const InSiteHeader = () => (
  <header className="flex w-full max-w-2xl items-center gap-4 rounded-md border border-border bg-background px-4 py-2">
    <span className="text-sm font-semibold tracking-tight">SHORTED</span>
    <nav className="flex items-center gap-4 text-sm text-muted-foreground">
      <span>Top shorts</span>
      <span>Screener</span>
      <span>Reports</span>
    </nav>
    <div className="ml-auto flex items-center gap-2">
      <Button size="sm" variant="outline">
        Sign in
      </Button>
      <ModeToggle />
    </div>
  </header>
);

/**
 * The same header rendered under `.dark` — CRT black on phosphor amber, and
 * the trigger has swapped the sun out for the moon.
 */
export const OnDark = () => (
  <div className="dark w-full max-w-2xl rounded-md bg-background p-4 text-foreground">
    <header className="flex items-center gap-4">
      <span className="text-sm font-semibold tracking-tight">SHORTED</span>
      <nav className="flex items-center gap-4 text-sm text-muted-foreground">
        <span>Top shorts</span>
        <span>Screener</span>
      </nav>
      <div className="ml-auto flex items-center gap-2">
        <Badge variant="secondary">ASIC 2026-06-04</Badge>
        <ModeToggle />
      </div>
    </header>
  </div>
);

/** In a card toolbar, sitting flush beside other ghost-weight actions. */
export const InCardToolbar = () => (
  <Card className="w-full max-w-md">
    <CardHeader className="flex-row items-start justify-between space-y-0 pb-2">
      <div>
        <CardTitle>Pilbara Minerals</CardTitle>
        <CardDescription>PLS · 19.4% short</CardDescription>
      </div>
      <div className="flex items-center gap-1">
        <Button size="sm" variant="ghost">
          Share
        </Button>
        <ModeToggle />
      </div>
    </CardHeader>
    <CardContent className="text-sm text-muted-foreground">
      Short interest has printed above 19% for eleven consecutive ASIC reports.
    </CardContent>
  </Card>
);
