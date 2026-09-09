import * as React from "react";
import { Container, Card, CardHeader, CardTitle, CardDescription, CardContent, Badge, Button } from "shorted";

/**
 * The canonical page wrapper: `container mx-auto px-5`. The tinted band is the
 * full-bleed page; the ruled box is what Container actually occupies, so the
 * centring and the 1.25rem gutters are visible.
 */
export const Default = () => (
  <div className="w-full bg-muted/40 py-6">
    <Container className="rounded-md border border-dashed border-border bg-background py-5">
      <h2 className="text-xl font-semibold">Top shorted stocks</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        ASIC reported short positions as at 4 June 2026.
      </p>
    </Container>
  </div>
);

/** A dashboard section: heading row plus the card grid Container centres. */
export const DashboardSection = () => (
  <div className="w-full bg-muted/40 py-6">
    <Container>
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Movers</h2>
        <Button size="sm" variant="outline">
          Export CSV
        </Button>
      </div>
      <div className="mt-4 grid gap-4 sm:grid-cols-3">
        {[
          { code: "PLS", name: "Pilbara Minerals", pct: "19.4%", delta: "+0.8" },
          { code: "BHP", name: "BHP Group", pct: "0.8%", delta: "−0.1" },
          { code: "CBA", name: "Commonwealth Bank", pct: "0.5%", delta: "+0.0" },
        ].map((s) => (
          <Card key={s.code}>
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <CardTitle className="text-base">{s.code}</CardTitle>
                <Badge variant="secondary">{s.delta}</Badge>
              </div>
              <CardDescription>{s.name}</CardDescription>
            </CardHeader>
            <CardContent className="text-2xl font-semibold">{s.pct}</CardContent>
          </Card>
        ))}
      </div>
    </Container>
  </div>
);

/**
 * `className` is merged, so a reading column narrows the same wrapper —
 * this is how the weekly report body is laid out.
 */
export const NarrowReadingColumn = () => (
  <div className="w-full bg-muted/40 py-6">
    <Container className="max-w-xl rounded-md border border-dashed border-border bg-background py-5">
      <h2 className="text-lg font-semibold">Week 23 · Materials</h2>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
        Lithium names carried the sector again. Pilbara Minerals held above 19%
        of shares on issue for an eleventh consecutive report, while IGO and
        Liontown both saw short interest ease for the first time since March.
      </p>
    </Container>
  </div>
);

/** Stacked sections share the same gutters, so headings line up down the page. */
export const StackedSections = () => (
  <div className="w-full bg-muted/40 py-6">
    <Container className="space-y-4">
      <div className="rounded-md border border-dashed border-border bg-background p-4">
        <h3 className="text-sm font-semibold uppercase tracking-wide">Materials</h3>
        <p className="mt-1 text-sm text-muted-foreground">4.2% average short interest · 118 stocks</p>
      </div>
      <div className="rounded-md border border-dashed border-border bg-background p-4">
        <h3 className="text-sm font-semibold uppercase tracking-wide">Financials</h3>
        <p className="mt-1 text-sm text-muted-foreground">0.9% average short interest · 64 stocks</p>
      </div>
      <div className="rounded-md border border-dashed border-border bg-background p-4">
        <h3 className="text-sm font-semibold uppercase tracking-wide">Energy</h3>
        <p className="mt-1 text-sm text-muted-foreground">2.6% average short interest · 71 stocks</p>
      </div>
    </Container>
  </div>
);
