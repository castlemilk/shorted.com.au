# Shorted for Discord

A Discord app that brings Shorted into a chat: search ASX stocks as you type,
post a stock's short interest with its chart, and redraw that chart in place
with buttons (period, view) that everyone in the channel can press. With
Activities switched on, an **Interactive** button opens the site's full chart
inside Discord.

It is an **HTTP interactions endpoint**, not a gateway bot. Discord POSTs each
slash command, autocomplete keystroke and button press to
`https://shorted.com.au/api/discord/interactions`, signed with the app's key,
and the endpoint answers with the message. There is no process to keep running,
no bot user and no bot token at runtime: it deploys with the web app on every
merge to `main`.

## Commands

| Command | What it posts |
|---|---|
| `/stock <code>` | The stock's short interest, 30-day change, short position, shares on issue, days to cover, market cap and industry, over its 1-year short-interest chart |
| `/chart <code> [view] [period]` | The same message for any view (short interest, price and volume, both) and period (1M, 3M, 6M, 1Y, Max) |
| `/search <query>` | Up to 10 matches with their short interest, and a menu to chart one |
| `/top [count]` | The 5 to 25 most shorted stocks (default 10), and a menu to chart one |
| `/help` | The list, privately |

`code` autocompletes: typing a code or part of a name searches as you go, and
an empty field offers the most shorted stocks. A name typed without picking a
suggestion still works (`/stock pilbara` charts PLS: the best search match).

Under every chart are two rows of buttons: the periods, then the views, an
**Open on Shorted** link (the chart's share page) and, when enabled,
**Interactive**. A press redraws the message for everyone; the highlighted
button redraws it with the latest figures. The buttons carry their chart in
their `custom_id` (`chart:p:BHP:short:3m`), so a message posted months ago
still works after any deploy and the bot stores nothing.

Lookups that fail are answered privately (ephemeral), never posted to the
channel. Every message sets `allowed_mentions: { parse: [] }`, so a search for
"@everyone" pings no one.

## How it works

```
Discord ──POST, Ed25519-signed──▶ /api/discord/interactions (Vercel, Node)
                                    │ verify signature (401 if bad)
                                    │ route: handler.ts
                                    │ read: getStock, getShortInterestDeltas,
                                    │       searchStocks, getTopShortsSummary
                                    ▼
                   reply within 1.5s ──▶ the message itself
                   slower           ──▶ "thinking…" now, then PATCH the
                                        message over the interaction webhook
                                        (waitUntil keeps the function alive)

Discord media proxy ──GET──▶ /chart/<CODE>/image?view=&period=&v=<day>
                             (the existing 1200x630 chart card)
```

| Piece | Where |
|---|---|
| Endpoint | `web/src/app/api/discord/interactions/route.ts` |
| Router, deferral | `web/src/@/lib/discord/handler.ts` |
| Messages (embeds, buttons, menus) | `web/src/@/lib/discord/messages.ts` |
| Commands (registered and handled from one list) | `web/src/@/lib/discord/commands.ts` |
| Button state codec | `web/src/@/lib/discord/custom-id.ts` |
| Signature check | `web/src/@/lib/discord/verify.ts` |
| Reads (server actions, 6s cap each) | `web/src/@/lib/discord/data.ts` |
| Follow-up webhooks | `web/src/@/lib/discord/rest.ts` |
| Registration script | `web/scripts/discord-register-commands.ts` (`npm run discord:register`) |
| Activity page | `web/src/app/embed/discord/page.tsx`, `web/src/@/components/discord/discord-activity.tsx` |
| Activity redirect | `web/src/config/discord-activity.mjs` (in `next.config.mjs` `redirects()`) |
| Cloudflare SBFM skip for `/api/discord/` | `terraform/modules/cloudflare-edge/main.tf` (`app_api_security_skip`) |

The chart image is the share card the site already serves to unfurlers
(`/chart/[code]/image`). Its URL carries `v=<today in Sydney>`: Discord's media
proxy caches an image by URL, so without it a chart posted tomorrow would show
today's picture. The route ignores the parameter; the CDN keys on it.

The reads are the same server actions the stock pages use, through the same
caches and the first-party fetch, so Discord traffic lands on warm cache
entries and is never bucketed as an anonymous scraper at the edge.

Each interaction logs a `product_event` with `feature: "discord"`, the action
(`command_stock`, `component_chart`, `autocomplete`, ...), the status and
`event_type: immediate | deferred`, joinable with the rest of the cost
attribution stream (`docs/observability/cost-attribution.md`).

## Setting it up

### 1. Create the application

1. <https://discord.com/developers/applications> → **New Application**, named
   "Shorted". Set the icon (`web/public/icon-512.png`) and the description.
2. **General Information**: copy the **Application ID** and the **Public Key**.
3. **Installation**: tick **Guild Install** and **User Install**. Install link
   "Discord Provided Link". Scopes for both: `applications.commands` only.
   The bot needs no bot user, permissions or privileged intents: it only
   answers interactions.

### 2. Give Vercel the public key

Production (and preview, if you want to test a preview with a second app):

```bash
printf '%s' "<public key>" | vercel env add DISCORD_PUBLIC_KEY production
```

Without it the endpoint answers 503. The key is not a secret (it only
verifies), but it is server-only; it never needs `NEXT_PUBLIC_`.

### 3. Point Discord at the endpoint

After the deploy that carries the key: **General Information → Interactions
Endpoint URL** = `https://shorted.com.au/api/discord/interactions`, **Save**.
Discord sends a PING and a badly signed request, and saves the URL only if the
first gets a PONG and the second a 401. If it refuses:

- `curl -si -X POST https://shorted.com.au/api/discord/interactions` should
  answer **401**. A **503** means `DISCORD_PUBLIC_KEY` is missing from that
  deployment; a **403** with `cf-mitigated: challenge` means the Cloudflare
  SBFM skip has not been applied (`terraform-deploy` applies it), or Vercel's
  firewall is challenging the request.

### 4. Register the commands

Bot token: **Bot → Reset Token** (used by this script only; keep it out of the
repo and of Vercel).

```bash
cd web
# One server, instantly (for testing):
DISCORD_APPLICATION_ID=... DISCORD_BOT_TOKEN=... DISCORD_GUILD_ID=... npm run discord:register
# Everywhere (can take up to an hour to reach every client):
DISCORD_APPLICATION_ID=... DISCORD_BOT_TOKEN=... npm run discord:register
# Print the JSON without sending it:
npm run discord:register -- --dry-run
```

It overwrites the app's whole command set, keeping the Activity's Entry Point
command if there is one. Re-run it after any change to `commands.ts`. The
script prints the install link.

### 5. Install it

Open the install link. "Add to Server" puts the commands in a server; "Add to
My Apps" lets you use them anywhere, including servers that have not added the
app, when the server allows external apps.

## The Activity (interactive chart inside Discord)

The chart messages are pictures: a fresh one per button press. The Activity is
the real chart, the site's `StockChartEmbed` with every period and view, the
scrub readout, pinning and measuring, plus a stock search box, running in an
iframe inside Discord. **Interactive** on a chart message launches it at that
chart (Discord passes the button's `custom_id` to the Activity's URL); the App
Launcher opens it at the default stock.

Discord serves an Activity from `https://<application id>.discordsays.com/`
through a proxy, and its CSP blocks every other host. So:

- The proxy's **root URL mapping** is the site: `/` → `shorted.com.au`. Every
  request the page makes is same-origin: the chart's queries already use the
  site's relative rewrites, the search box calls the `SearchService` rewrite,
  and the "on Shorted" button opens links through the SDK
  (`openExternalLink`), because a plain link does nothing inside an Activity.
- Discord always loads the mapping's root, `/`, with its launch parameters
  (`frame_id`, `instance_id`, `platform`, `custom_id`). The redirect in
  `src/config/discord-activity.mjs` sends exactly those requests (both
  `frame_id` and `instance_id` present) to `/embed/discord`, which can be
  framed (`frame-ancestors *`, like every `/embed/` page); every other visit
  to `/` is untouched.
- The page reads its application ID from its hostname, and completes Discord's
  handshake with `@discord/embedded-app-sdk` (loaded only on this page).
  Opened outside Discord (`/embed/discord?code=BHP&view=combined`) it is a
  plain chart page, which is how to check it in a browser.

To switch it on:

1. Developer portal → **Activities → Settings**: enable Activities.
2. **Activities → URL Mappings**: one mapping, prefix `/`, target
   `shorted.com.au` (no protocol).
3. Vercel: `DISCORD_ACTIVITY_ENABLED=true` (production), and redeploy. Only
   then do chart messages show **Interactive**: launching an Activity for an app
   without one fails in Discord, so the button stays hidden until this is set.
4. Re-run `npm run discord:register` once (globally): enabling Activities
   created the Entry Point command, and the script keeps it.

Each person in the Activity explores on their own; it does not sync one
person's chart to the others.

## Landmines

- **Discord allows three seconds.** The handler waits 1.5s for a reply
  (`DEFAULT_FAST_PATH_MS`) and otherwise defers. Autocomplete cannot be
  deferred: it answers with whatever arrived in time, or the typed code. Do not
  raise the fast path to "avoid the thinking state": a cold start sits inside
  the same three seconds.
- **A public deferral cannot become private.** When a slow reply turns out to be
  a private note (nothing matched), the handler deletes the "thinking…"
  message and sends the note as an ephemeral follow-up. On a button press it
  leaves the chart as it was and sends the note.
- **Five buttons per row.** The period row is full (1M, 3M, 6M, 1Y, Max).
  The site's 2Y is left out on purpose; the image route still draws it.
- **`custom_id` is a public contract.** Old messages keep sending the ids they
  were posted with. Add new kinds; do not change what an existing one means.
  `parseCustomId` rejects anything malformed, and the handler answers an id it
  does not know with a private "run the command again".
- **The bot never needs a bot token at runtime.** Replies and follow-ups use
  the interaction's own token (valid 15 minutes). Do not add one to Vercel.
- **SBFM.** Cloudflare's Super Bot Fight Mode challenges automated clients on
  the apex, and Discord's interaction POSTs are one. `/api/discord/` is in the
  app API skip rule (`security-skip-expression.test.mjs`); the route's
  signature check is what keeps it closed.
- **`@vercel/functions` is pinned to 1.x** for `waitUntil`: 3.x pulls in an OIDC
  and CLI-config chain and moved next-auth's `jose`.
