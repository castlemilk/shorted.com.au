import * as React from "react";
import { Avatar, Card, CardHeader, CardTitle, CardDescription, CardContent, Badge } from "shorted";

// Local helper (not exported, so it is not a card cell). Avatar renders a
// next/image with `fill`; a data: URI is passed through the optimiser
// untouched, which is what makes it paint outside a Next server.
const portrait = (initials: string, bg: string, fg: string) =>
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96">` +
      `<rect width="96" height="96" fill="${bg}"/>` +
      `<text x="48" y="63" text-anchor="middle" fill="${fg}" ` +
      `font-family="IBM Plex Mono, monospace" font-size="38" font-weight="600">${initials}</text>` +
      `</svg>`,
  );

const AMBER = portrait("HC", "rgb(191,110,42)", "rgb(255,247,237)");
const CHOCOLATE = portrait("MR", "rgb(61,44,33)", "rgb(240,213,166)");
const SLATE = portrait("JT", "rgb(74,86,92)", "rgb(233,238,240)");
const CLAY = portrait("SN", "rgb(140,58,48)", "rgb(255,240,232)");

/** The canonical use: a 40px circular portrait keyed by `name` and `picture`. */
export const Default = () => (
  <div className="flex items-center gap-3">
    <Avatar name="Harriet Cole" picture={AMBER} />
    <div className="leading-tight">
      <div className="text-sm font-medium">Harriet Cole</div>
      <div className="text-xs text-muted-foreground">Equities desk</div>
    </div>
  </div>
);

/** `size` drives both box and next/image `sizes` — 24 / 32 / 40 (default) / 64. */
export const Sizes = () => (
  <div className="flex items-end gap-5">
    {[24, 32, 40, 64].map((s) => (
      <div key={s} className="flex flex-col items-center gap-2">
        <Avatar name="Marcus Reid" picture={CHOCOLATE} size={s} />
        <span className="text-xs text-muted-foreground">{s}px</span>
      </div>
    ))}
  </div>
);

/** A report byline — avatar beside the author line above a weekly short-selling note. */
export const Byline = () => (
  <Card className="max-w-md">
    <CardHeader className="pb-3">
      <CardTitle>Week 23: the Pilbara squeeze</CardTitle>
      <CardDescription>Published 6 June · ASIC report 2026-06-04</CardDescription>
    </CardHeader>
    <CardContent className="flex items-center gap-3">
      <Avatar name="Jia Tan" picture={SLATE} size={32} />
      <div className="text-xs leading-tight">
        <div className="font-medium">Jia Tan</div>
        <div className="text-muted-foreground">Research · 4 min read</div>
      </div>
    </CardContent>
  </Card>
);

/** Overlapping stack with a count chip — who else is watching this ticker. */
export const Stack = () => (
  <div className="flex items-center gap-3">
    <div className="flex">
      {[AMBER, CHOCOLATE, SLATE, CLAY].map((p, i) => (
        <div
          key={i}
          className="rounded-full ring-2 ring-background"
          style={{ marginLeft: i === 0 ? 0 : -8 }}
        >
          <Avatar name={`Watcher ${i + 1}`} picture={p} size={32} />
        </div>
      ))}
    </div>
    <span className="text-xs text-muted-foreground">+12 watching BHP</span>
  </div>
);

/** In a comment row: 32px avatar, author, timestamp, and a sentiment Badge. */
export const CommentRow = () => (
  <Card className="max-w-md">
    <CardContent className="flex gap-3 pt-6">
      {/* shrink-0: Avatar sizes itself with inline width/height, so a flex
          row squashes it into a sliver without this. */}
      <div className="shrink-0">
        <Avatar name="Sofia Nunes" picture={CLAY} size={32} />
      </div>
      <div className="space-y-1">
        <div className="flex items-center gap-2 text-xs">
          <span className="font-medium">Sofia Nunes</span>
          <span className="text-muted-foreground">2h ago</span>
          <Badge variant="secondary">Bearish</Badge>
        </div>
        <p className="text-sm text-muted-foreground">
          PLS short interest has printed above 19% for eleven straight ASIC
          reports, and the borrow is not getting cheaper.
        </p>
      </div>
    </CardContent>
  </Card>
);
