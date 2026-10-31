# Shorted for Discord

A Discord app that brings Shorted into a chat: search ASX stocks as you type,
post a stock's short interest with its chart, and redraw that chart in place
with buttons that everyone in the channel can press, and an **Interactive**
button that opens the site's full chart inside Discord (the Activity).

## Quick start

1. **Create the app.** <https://discord.com/developers/applications> →
   **New Application** → name it "Shorted". Add one credential to the repo's
   `.env` (gitignored), or to the cloud environment's variables:

   ```bash
   DISCORD_BOT_TOKEN=...      # Bot → Reset Token: setup does everything
   DISCORD_CLIENT_SECRET=...  # OAuth2 → Client Secret: setup does all but
                              # step 3's app settings, which it prints
   ```

   The two are easy to swap: a bot token has three dot-separated parts, a
   client secret is 32 characters. The script recognises a client secret in
   either variable and says so.

2. **Record it.** `task discord:setup` writes the app's id and public key to
   `web/src/config/discord-app.json`. Commit that file and merge it to `main`.
   With a client secret, the first run names the app:
   `task discord:setup -- --app <application id>`.

3. **Finish.** Once the deploy is out, `task discord:setup` again. It
   registers the commands and prints the install links. With a bot token it
   also points Discord at the endpoint and sets the install options,
   description, tags and icon. With a client secret it prints those as portal
   settings instead, because only a bot token may edit the application:
   - **General Information → Interactions Endpoint URL:**
     `https://shorted.com.au/api/discord/interactions`. Discord sends a signed
     PING when you save, so the deploy must be out first.
   - **Installation → Installation Contexts:** User Install and Guild Install.
   - **Installation → Default Install Settings:** scope `applications.commands`
     for both, no permissions.

   (Or run step 2 with `-- --wait`: it waits for the deploy and finishes on
   its own.)

**No OAuth2 redirect.** Leave OAuth2 → Redirects empty and **Requires OAuth2
Code Grant** off: the bot answers interactions and never runs an OAuth2 code
flow, and the install links need no redirect. The Activity does not
authenticate users either (it only completes the SDK's `ready` handshake). The
client secret is used only by the setup script, never by the deployed site.

`task discord:status` shows where things stand at any time. `task discord:setup`
is safe to run again: it changes only what has drifted.

The public page for people adding the app is
[`/docs/discord`](https://shorted.com.au/docs/discord)
(`web/src/app/docs/discord/page.tsx`). It renders its command table from
`COMMANDS` and its install buttons from the committed app, so it shows "being
set up" until step 2 is merged and needs no edit afterwards.

## Commands

| Command | What it posts |
|---|---|
| `/stock [code]` | The stock's short interest, 30-day change, short position, shares on issue, days to cover, market cap and industry, over its short-interest chart |
| `/chart [code] [view] [period]` | The same message for any view (short interest, price and volume, both) and period (1M, 3M, 6M, 1Y, Max) |
| `/search <query>` | Up to 10 matches with their short interest, and a menu to chart one |
| `/top [count]` | The 5 to 25 most shorted stocks (default 10), and a menu to chart one |
| `/settings [for]` | The settings that apply, privately, with a link to change them (below) |
| `/help` | The list, privately |

`code` autocompletes: typing a code or part of a name searches as you go, and
an empty field offers the most shorted stocks. A name typed without picking a
suggestion still works (`/stock woodside` charts WDS, the best match). With a
default stock set, `code` can be left out; without one, the command asks for
one, privately.

Under every chart are two rows of buttons: the periods, then the views, an
**Open on Shorted** link (the chart's share page) and **Interactive** (the
Activity, below). A press redraws the message for everyone; pressing the
highlighted one redraws it with the latest figures. **Open on Shorted** carries
`landscape=1`: Discord's in-app browser keeps to portrait whatever the phone
does, so on a phone held upright the share page opens with the chart turned
sideways (its landscape mode, `StockChartEmbed` `startLandscape`); anywhere
else the flag does nothing.

## Settings

Out of the box a chart command needs a code, opens the short-interest chart
over a year, and posts a chart message. `/settings` changes that, for a server
or for one person:

| Setting | Values | Built in |
|---|---|---|
| Default stock | any ASX code, or none (a command without a code asks) | none |
| Chart | short interest, price, combined | short interest |
| Period | 1M, 3M, 6M, 1Y, Max (the message's buttons) | 1Y |
| Commands open | a chart message, or the interactive chart (the Activity) | a chart message |

**Layers.** A server's settings apply to everyone in it; a person's own apply
in DMs and group DMs, and in servers with none of their own; the built-ins fill
the rest. Anything typed in a command wins over all three
(`/chart BHP view:price`). `settings.ts` resolves them field by field, and a
read slower than 500ms (`SETTINGS_BUDGET_MS`) is not waited for: the built-ins
stand in, and the read still fills the cache.

**Who may change what is decided in Discord.** `/settings` in a server changes
the server's settings when the member has Manage Server or Administrator
(Discord computes `member.permissions` and signs the interaction); otherwise,
in a DM, or with `for:Just me`, the person's own. It answers privately with the
settings now and a **Change settings** link to `/discord/settings`, signed for
that one scope and person and good for 30 minutes (`settings-link.ts`). The
link is a grant, so the page has no Discord sign-in and the deployment needs no
client secret:

- The signing key is derived from `NEXTAUTH_SECRET` under its own label, so
  nothing else signed with that secret can be replayed as a grant. Without the
  secret, `/settings` says settings cannot be changed right now.
- The link lands on `/discord/settings/open`, which moves the token into an
  httpOnly cookie scoped to `/discord/settings` for the grant's lifetime and
  redirects to the page's clean URL, so the token is not left in the address
  bar, the history or analytics. An expired or forged link clears the cookie
  and the page says the link has expired.
- The page and its actions (`app/discord/settings/actions.ts`) re-read the
  grant from the cookie on every call. Nothing the browser sends decides whose
  settings change, a form left open past 30 minutes cannot save, and a default
  stock that does not exist is refused.

The page previews the result live: the chart message is drawn from the payload
`buildChartMessage` builds, with the stock's real readings and chart card, and
interactive mode frames `/embed/discord` itself.

**Storage.** Firestore collection `discord_settings`, one document per scope
(`guild:<id>`, `user:<id>`), written whole, with `updatedBy` and `updatedAt`
(`settings-store.ts`). Reads fail open (nothing set) and are cached per
instance for a minute, so a change shows everywhere within a minute; the
settings page reads fresh.

**Interactive mode.** With "Commands open: the interactive chart", `/stock` and
`/chart` answer with `LAUNCH_ACTIVITY` instead of a message. That response has
no room for the chart and cannot be deferred, so the command's chart is handed
over through Upstash KV (`discord:launch:<channel id>`, 2 minutes,
`launch.ts`), and the Activity asks `/api/discord/activity/launch` as it loads:
the command's chart in this channel, else the server's defaults, else its own
default. A lookup that cannot finish inside the 1.5s fast path posts the chart
message instead; an unknown stock is answered privately, as ever.

Lookups that fail are answered privately (ephemeral), never posted to the
channel. Every message sets `allowed_mentions: { parse: [] }`, so a search for
"@everyone" pings no one.

## How it works

It is an **HTTP interactions endpoint**, not a gateway bot: there is no process
to run and no bot token in production. Discord POSTs each slash command,
autocomplete keystroke and button press to
`https://shorted.com.au/api/discord/interactions`, signed with the app's
Ed25519 key, and the endpoint answers with the message. It deploys with the web
app.

```
Discord ──POST, Ed25519-signed──▶ /api/discord/interactions (Vercel, Node)
                                    │ verify the signature (401 if bad)
                                    │ route: handler.ts
                                    │ read: getStock, getShortInterestDeltas,
                                    │       searchStocks, getTopShortsSummary
                                    ▼
                   reply within 1.5s ──▶ the message itself
                   slower           ──▶ "thinking…" now, then the message over
                                        the interaction's webhook (waitUntil)
                   a chart          ──▶ deferred at once; the edit uploads the
                                        1200x630 chart card it draws
```

| Piece | Where |
|---|---|
| Endpoint (POST: interactions; GET: status) | `web/src/app/api/discord/interactions/route.ts` |
| Which app: id, public key, Activity switch | `web/src/config/discord-app.json`, read by `web/src/@/lib/discord/config.ts` |
| Router, deferral | `web/src/@/lib/discord/handler.ts` |
| Messages (embeds, buttons, menus) | `web/src/@/lib/discord/messages.ts` |
| Commands (registered and handled from one list) | `web/src/@/lib/discord/commands.ts` |
| Button state codec | `web/src/@/lib/discord/custom-id.ts` |
| Signature check | `web/src/@/lib/discord/verify.ts` |
| Reads (the stock pages' server actions, 6s cap each) | `web/src/@/lib/discord/data.ts` |
| Follow-up webhooks (JSON, or multipart with a card) | `web/src/@/lib/discord/rest.ts` |
| Chart card, drawn for each chart message | `web/src/@/lib/discord/chart-card.ts`, over the share card's `web/src/app/chart/[code]/image/load-card.tsx` |
| Setup and status | `web/scripts/discord.ts` (`task discord:*`), decisions in `web/src/@/lib/discord/setup.ts` |
| Activity page | `web/src/app/embed/discord/page.tsx`, `web/src/@/components/discord/discord-activity.tsx` |
| Activity redirect | `web/src/config/discord-activity.mjs` (in `next.config.mjs` `redirects()`) |
| Cloudflare bot-fight skip for `/api/discord/` | `terraform/modules/cloudflare-edge/main.tf` (`app_api_security_skip`) |

**The app is configuration.** Its id and public key are public values (the key
only verifies Discord's signatures), so they are committed and reviewed like
any other config; `task discord:setup` writes them. Until they are filled in,
the endpoint answers 503 and Discord will not accept its URL. For a second app
(a preview deployment, or a tunnel to `next dev`), set `DISCORD_PUBLIC_KEY` on
that deployment and pass `-- --endpoint <url>` to the tasks.

**The chart image** is the share card the site serves to unfurlers
(`/chart/<CODE>/image`), uploaded with the message as
`attachment://<CODE>-<view>-<period>.png` (`lib/discord/chart-card.ts`). It used
to be that card's URL, for Discord's media proxy to fetch. Every period or view
button names a new URL, so the proxy fetched each one cold (1.5 to 5s to
render, measured 2026-10-31), through Cloudflare's bot checks, and a slow or
refused fetch left the redrawn chart blank or stale, which the proxy then kept
for that URL. An upload arrives with the edit itself. So every chart reply is
deferred: a button press answers `DEFERRED_UPDATE_MESSAGE` at once (its loading
state is the feedback) and the webhook edit carries the new card; a command
waits only to learn whether the stock exists, so a typo is still answered
privately and at once. The stock read and the card run side by side.

Where the card comes from:

- **The share card's route, cached.** The bot fetches
  `/chart/<CODE>/image?…&v=<today in Sydney>`, the URL a message would
  otherwise carry, with the first-party SSR marker and secret, which the zone's
  skip rule matches on this host, so Cloudflare lets it through. The CDN keeps
  the card, so a period or view seen once today comes back in about 70ms, and
  the render runs in the route's own function. Drawing it in the bot's function
  (the first version of this) blocked it for a second or more, so a second
  press arriving during one could miss Discord's three seconds ("This
  interaction failed"), and nothing was cached.
- **The neighbours, ahead of the press.** After a chart goes out, the bot has
  the CDN draw the six charts one press away (the other four periods, the other
  two views), two at a time in the background, so the first press on each is
  cached too.
- **Drawn in the bot's function** when the secret is missing, the route fails,
  or it answers a partial card (`x-chart-card: partial`, a read timed out).
- **The card's URL**, as before, when no whole card arrives within 9s.

**Retries.** Webhook calls (the edit, a follow-up, a delete) are tried up to
three times: after a 429 (its `Retry-After`, capped at 5s), a 5xx, or for an
edit or a delete a dropped connection. A follow-up is not resent after a dropped
connection, which may have posted it. A button's stock read that comes back
empty is tried once more after 400ms before the presser is told it failed.

**Warm.** Discord fails an interaction not answered in three seconds, and a
cold start can take most of them, so a Vercel cron GETs the endpoint's status
every five minutes (`vercel.json`; the cost config test pins it).

**The reads** are the server actions the stock pages use, through the same
caches and the first-party fetch, so Discord traffic lands on warm entries and
is never bucketed as an anonymous scraper at the edge.

**The buttons carry their chart** in their `custom_id`
(`chart:p:BHP:short:3m`), so the bot stores nothing, and a message posted
months ago still works after any deploy.

Each interaction logs a `product_event` with `feature: "discord"`, the action
(`command_stock`, `component_chart`, `autocomplete`, ...), the status and
`event_type: immediate | deferred` (`docs/observability/cost-attribution.md`).

## The tasks

| Task | Does |
|---|---|
| `task discord:status` | Read-only: the config, the live endpoint's key, the app's endpoint URL and the registered commands, each ✓ or ✗, and the install links |
| `task discord:setup` | Everything in the quick start, idempotently |
| `task discord:register` | Re-upload the commands after editing `commands.ts` |

Flags go after `--`: `--guild <id>` registers to one server, where commands
appear at once (global ones can take up to an hour); `--endpoint <url>` targets
another deployment; `--wait` waits for the deploy; `--dry-run` changes nothing.
A token for a different app than the config records is refused unless
`--write-config`, because that would switch production's bot.

What setup sets on the app: the Interactions Endpoint URL; installation to
servers and to users' accounts with the `applications.commands` scope only (no
bot user permissions, no privileged intents: it only answers interactions);
and a description, tags and the Shorted icon where the app has none, so
anything set in the portal is kept. Bulk-registering the commands keeps the
Activity's Entry Point command when there is one.

## The Activity (interactive chart inside Discord)

The chart messages are pictures: a fresh one per button press. The Activity is
the real chart, the site's `StockChartEmbed` with every period and view, the
scrub readout, pinning and measuring, plus a stock search box, in an iframe
inside Discord. **Interactive** on a chart message launches it at that chart:
Discord does not pass the pressed button to the Activity (a CBA message opened
the server's default stock, DRO, 2026-10-31), so the button hands its chart over
by channel first, as interactive mode does (`launch.ts`), and the Activity's
launch lookup finds it. The App Launcher opens it at the server's default
stock. Each person explores on their own; it
does not sync one person's chart to the others.

Discord serves an Activity from `https://<application id>.discordsays.com/`
through a proxy, and its CSP blocks every other host. So:

- The proxy's **root URL mapping** is the site: `/` → `shorted.com.au`. Every
  request the page makes is same-origin: the chart's queries use the site's
  relative rewrites, the search box calls the `SearchService` rewrite, and the
  "on Shorted" button opens links through the SDK (`openExternalLink`), because
  a plain link does nothing inside an Activity.
- Discord always loads the mapping's root, `/`, with its launch parameters
  (`frame_id`, `instance_id`, `platform`, `custom_id`). The redirect in
  `src/config/discord-activity.mjs` sends exactly those requests (both
  `frame_id` and `instance_id` present) to `/embed/discord`, which can be
  framed (`frame-ancestors *`, like every `/embed/` page); every other visit to
  `/` is untouched.
- The page reads its application id from its hostname and completes Discord's
  handshake with `@discord/embedded-app-sdk`, loaded on this page only. Opened
  outside Discord (`/embed/discord?code=BHP&view=combined`) it is a plain chart
  page, which is how to check it in a browser.
- **Nothing on it may navigate the frame.** Discord's mobile webview follows a
  plain link in place, which loaded the whole site, header and footer, inside
  the Activity (reported 2026-10-29). So the embed layout's corner credit is
  left off this page (`app/embed/embed-brand-link.tsx`), and while the SDK is
  connected a capture-phase click handler sends every link out through
  `openExternalLink`.
- **Phones.** On mobile the page asks Discord to unlock its orientation
  (`setOrientationLockState`), so a phone turned sideways turns the chart; the
  layout fits a sideways phone (330px tall) without scrolling. Where Discord
  keeps it upright anyway, the chart offers its landscape mode (the
  sideways-phone button), as the share page does.

The Activity is on (`"activity": true` in `web/src/config/discord-app.json`,
2026-10-23), so every chart message carries **Interactive**. What it takes, in
order, for this app or a second one:

1. Developer portal → **Activities → Settings**: enable Activities. Only the
   portal does this: Discord's public API has no field for it, and a client
   secret cannot edit the app at all. The public
   `GET https://discord.com/api/v10/applications/<id>/rpc` shows it took:
   `flags` gains `EMBEDDED` (`1 << 17`).
2. **Activities → URL Mappings**: one mapping, prefix `/`, target
   `shorted.com.au` (no protocol). Unmapped,
   `curl -s "https://<id>.discordsays.com/?frame_id=x&instance_id=y"` is
   Discord's own page, titled "Discord Activity not available at this time";
   mapped, it is the site's answer (a 307 to `/embed/discord` once step 3 is
   deployed, Cloudflare's challenge before).
3. Cloudflare lets the Activity through: Discord's proxy fetches from Discord's
   servers, an automated client, and Super Bot Fight Mode managed-challenged
   both the launch and `/embed/discord` (403 `cf-mitigated: challenge`,
   2026-10-23), which inside Discord is the "Just a moment…" page. The rule
   "Allow the Discord Activity" in `app_api_security_skip`
   (`terraform/modules/cloudflare-edge/main.tf`) skips SBFM for `/` only when
   it carries both `frame_id` and `instance_id`, and for `/embed/discord`; the
   page's JS, CSS and fonts bypass SBFM by extension, and its data calls are
   the RPC rewrites, already skipped. `security-skip-expression.test.mjs`
   evaluates it both ways.
4. Set `"activity": true` and merge, after step 1: Discord refuses a launch for
   an app without Activities, so the button would fail until it is done.
   `curl -s https://shorted.com.au/api/discord/interactions` then reports
   `"activity": true` (a `DISCORD_ACTIVITY_ENABLED` env var on the deployment
   would override the file).
5. `task discord:register` once: enabling Activities created the Entry Point
   command, and registration keeps it.
6. Press **Interactive** on a chart message and check the chart loads.

### Proxy authentication

With proxy authentication on for the app in the developer portal (on since
2026-10-23), Discord's proxy adds three headers to what it forwards from the
Activity: `X-Discord-Proxy-Payload` (base64 JSON with the user's context and
`created_at` / `expires_at`), `X-Signature-Ed25519` (the application key's
signature of those payload bytes) and `X-Signature-Timestamp` (`created_at`
again). The key is the one in `discord-app.json`, the same key that signs
interactions.

What a valid set proves, and what it does not:

- It proves the request came through Discord's proxy for this app, for the
  user in the payload, before `expires_at`. The signature covers the payload
  only, not the path, method or body, so a captured set can be replayed on any
  path until it expires. Treat it as a short-lived session pass: it may say
  who is asking, but never authorises a write on its own.
- The rules `verifyDiscordProxyRequest` (`web/src/@/lib/discord/verify.ts`)
  keeps: verify the signature over the payload's exact bytes BEFORE reading a
  field; the timestamp header equals `created_at`; `expires_at` not passed;
  `created_at` at most 60s ahead of our clock; the signature in hex or base64
  (Discord's samples disagree), 64 bytes either way; 401 on any failure; never
  throw.
- Interactions use the same key and the same header names over a different
  message (the timestamp, then the body). `verifyDiscordRequest` accepts only a
  timestamp of digits, so a proxy payload (which starts with `{`) can never be
  replayed as an interaction; `verify.test.ts` tries every split.
- Never log the headers or the payload's values.

**Stage 1 (now): observe.** After Discord's handshake the Activity POSTs once
to `/api/discord/activity` (through the proxy, in the Cloudflare skip with the
rest of `/api/discord/`). The route verifies and records a `product_event`
(`feature: "discord"`, `action: "activity_proxy_auth"`, `event_type` one of
`verified`, `missing`, `malformed`, `bad_signature`, `bad_payload`,
`timestamp_mismatch`, `expired`, `not_yet_valid`), plus one
`discord_proxy_payload_fields` line per payload shape naming its fields,
never their values. It answers 204 (verified, or no headers) or 401 (headers
that fail); the Activity ignores the answer.

**Stage 2: require them, once the data says so.** When real launches read
`verified` and no `missing`, the Cloudflare rule "Allow the Discord Activity"
can also require the proxy's headers to be present (Cloudflare cannot check a
signature, so presence only filters bots that do not send them), and anything
that needs to know the user (state shared per `instance_id`, a saved list) can
take it from a verified payload instead of an OAuth flow. Confirming that the
user is in a live instance needs the activity-instances API and a bot token;
this repo holds only a client secret.

## Troubleshooting

`task discord:status` names the broken link. Otherwise:

- `curl -s https://shorted.com.au/api/discord/interactions` should answer
  `{"service":"shorted-discord","configured":true,...}`. `configured: false`
  means the config has not been deployed. A `403` with `cf-mitigated: challenge`
  means Cloudflare's bot-fight skip for `/api/discord/` is not applied
  (`terraform-deploy` applies it) or Vercel's firewall is challenging the
  request.
- "This interaction failed" in Discord with nothing in the logs: the request
  did not reach the endpoint (see above), or the Interactions Endpoint URL in
  the portal points elsewhere (`task discord:status`).
- Commands missing: global registration takes up to an hour to reach every
  client; `-- --guild <id>` shows them in one server at once.
- `/settings` says settings cannot be changed: the deployment has no
  `NEXTAUTH_SECRET`. "Couldn't save" on the page: Firestore is unreachable or
  the admin credentials are missing (the function log says which).
- Settings changed but a chart still opens the old way: each instance caches
  them for a minute.

## Landmines

- **Discord allows three seconds.** The handler waits 1.5s for a reply
  (`DEFAULT_FAST_PATH_MS`) and otherwise defers. Autocomplete cannot be
  deferred: it answers with whatever arrived in time, or the typed code. Do not
  raise the fast path to "avoid the thinking state": a cold start sits inside
  the same three seconds.
- **A public deferral cannot become private.** When a slow reply turns out to
  be a private note (nothing matched), the handler deletes the "thinking…"
  message and sends the note as an ephemeral follow-up. On a button press it
  leaves the chart as it was and sends the note.
- **Five buttons per row.** The period row is full (1M, 3M, 6M, 1Y, Max).
  The site's 2Y is left out on purpose; the image route still draws it.
- **`custom_id` is a public contract.** Old messages keep sending the ids they
  were posted with. Add new kinds; do not change what an existing one means.
  `parseCustomId` rejects anything malformed, and the handler answers an id it
  does not know with a private "run the command again".
- **No credentials in production.** Replies and follow-ups use the
  interaction's own token (valid 15 minutes). The bot token or client secret
  belongs in `.env` for the tasks only, never in Vercel.
- **SBFM.** Cloudflare's Super Bot Fight Mode challenges automated clients on
  the apex, and Discord's interaction POSTs are one. `/api/discord/` is in the
  app API skip rule (`security-skip-expression.test.mjs`); the route's
  signature check is what keeps it closed.
- **`@vercel/functions` stays on 1.x** for `waitUntil`: 3.x pulls in an OIDC
  and CLI-config chain and moved next-auth's `jose`.
- **A settings link is a bearer grant for 30 minutes.** Anyone holding it can
  change that scope's settings until it expires, which is why `/settings`
  answers privately and the page moves it out of the URL at once. Do not
  lengthen its life, and do not log the `open` route's query string.
- **Rotating `NEXTAUTH_SECRET` voids every open settings link** (and every
  next-auth session); people run `/settings` again. Nothing stored changes.
- **`LAUNCH_ACTIVITY` cannot be deferred.** Interactive mode answers inside the
  fast path or falls back to a chart message; never make it wait on a read
  without a bound.
- **An interaction's HTTP response cannot upload.** It is JSON, so a reply that
  carries a file (every chart message) is delivered by the webhook edit after a
  deferral; `handleInteraction` defers any reply with `files`. Do not move the
  chart back to an image URL to answer "instantly": that is the unreliable
  path this replaced.
- **The share page's `landscape=1` is Discord's.** Only the bot's
  **Open on Shorted** link carries it; the share dialog's links do not, so a
  chart shared to a forum opens the way it always did.
