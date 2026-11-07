# Share & embed: the chart share page, the card, landscape mode and indicators

Moved out of `CLAUDE.md` on 2026-11-07 so the session context stays small. `CLAUDE.md` keeps the rules that shape every change here and points at this file; the full record lives here. Keep the two in step: a new landmine goes HERE, and only a rule every session needs goes in `CLAUDE.md`.

## Share & embed (charts and widgets)

Every embeddable widget carries a **Share** button (`components/ui/embed-dialog.tsx`;
the dialog body is a lazy chunk, `embed-dialog-content.tsx`). It offers a link,
the native share sheet where there is one, and copy per destination: Discord,
Slack, X, LinkedIn, Reddit, Markdown and Website (`lib/embed/share.ts`). Only
Website is the HTML `<figure>` snippet (`lib/embed/snippet.ts`, whose comment
explains the host-page credit); every other channel is a link plus a line,
because chat apps show HTML as text (a WBT snippet pasted into Discord,
2026-10-19).

| Piece | Where |
|---|---|
| Chart share page `/chart/<CODE>?view=&period=` | `app/chart/[code]/` (noindex, follow; no site chrome; params and fallbacks are `/embed/chart`'s, `app/embed/chart/params.ts`) |
| Its card `/chart/<CODE>/image` | `app/chart/[code]/image/route.tsx` + `lib/og/chart-image.ts` (geometry) + `lib/og/chart-card.tsx`: the chart itself, 1200x630, never a 500 |
| Landscape mode | `StockChartEmbed` `allowLandscape`: on a portrait phone the box is turned 90deg with CSS (`portrait:` variants), because rotation lock cannot be overridden and iOS has no orientation lock API |
| Indicators | `components/charts/chart-indicators.ts` (registry, base and advanced sets, warm-up plan), `chart-indicator-math.ts`, `indicator-layout.ts`, `indicator-menu.tsx`, `use-indicator-history.ts`. `StockChartEmbed` `indicators`: the share page `unlock: "session"`, the Discord Activity `unlock: "never"` (its sign-in is `onSignIn`, which opens outside Discord), `/embed/chart` none (the prop is omitted: no menu, no legend, no extra query) |

### Landmines

- **A chart as posted takes `?asof=&shorts=&prices=`.** `/chart/<CODE>`, `/chart/<CODE>/image`, `/embed/chart` and the Activity accept the three dates of an anchor (`chart-anchor.ts`: the posting day, the newest report and the newest close). A settled anchored card (posted 2+ days ago, report 8+ days old, complete with name and both logos) is cached 30 days at the CDN, and its data 7 days. Anything else uses the existing policies.
- **`/chart/` must stay out of robots.txt; `/embed/` stays in it.** Twitterbot
  and Slackbot honour robots.txt, so a disallowed share link posts with no
  preview. The share page keeps itself out of the index with its noindex meta.
  `robots-rpc-disallow.test.ts` pins both.
- **The card's Cache-Control key is lowercase** (`ImageResponse` spreads caller
  headers over its own `cache-control`; a capitalised key is appended to the
  one-year immutable default). A card missing a series it asked for is cached
  for 5 minutes, not 6 hours.
- **Never wrap a Discord link in `<angle brackets>`**: Discord suppresses the
  preview. Tickers are `ASX:CODE` on X, LinkedIn and Reddit (`$CODE` reads as
  a US cashtag).
- **The rotated chart reads the pointer through `getScreenCTM`** (visx
  `localPoint`), which includes the CSS rotation. A pointer path that uses
  `getBoundingClientRect` or `clientX` arithmetic would break scrubbing in
  landscape.
- **Nothing that positions with floating-ui may render inside the landscape
  box.** Radix Popover, DropdownMenu and Tooltip place themselves from
  `getBoundingClientRect`, which a rotated containing block breaks; a portal is
  unrotated and sits under the box's `z-[60]`. So the indicator menu is
  CSS-positioned inside the chart box and turns with it, and the Activity's
  search is an upright dialog at `z-[70]`.
- **The landscape box hears Escape on `window`, after every other listener,
  and ignores an Escape already handled (`defaultPrevented`).** Every handler
  that takes an Escape calls `preventDefault` (Radix does; the indicator menu
  does when the Escape comes from inside it, where focus is); one that does not
  leaves landscape on the same press. The host can hold the choice itself
  (`StockChartEmbed` `landscape`, controlled): the chart then only reports
  the toggle and Escape, and the host answers by changing it.
- **`chart-indicators.ts` imports only types from `chart-views.ts` and stays
  free of `"use client"`.** Server code (the share page's metadata, the bot's
  messages) reaches it through `chart-views.ts`, so a value import back is a
  module cycle. `indicator-menu.tsx` and `use-indicator-history.ts` are client
  modules imported only by `StockChartPanel` and `StockChartEmbed`, which are
  dynamic islands (`ssr-import-safety.test.ts` does not follow them).

