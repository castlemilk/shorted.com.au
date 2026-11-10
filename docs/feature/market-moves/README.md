# Market moves

A Claude workflow watches the market and posts what moved, by how much, when it
saw it and why, with a token an administrator creates in the admin console. Shorted stores each move, serves it through the public API and
draws it on three surfaces: the `/market-moves` feed, a strip on the homepage,
and a card on the Overview tab of every stock the move names. A move is live as
soon as the post returns. The `/market-moves` page says the moves are written by
an AI workflow; the cards themselves name no author (removed at the owner's
request, 2026-11-09).

| Piece | Where |
|---|---|
| Tables | `market_moves` and `market_moves_tokens`, migration `000160_market_moves` (in the deploy allowlist, replay-safe) |
| Store | `services/shorts/internal/store/shorts/postgres_market_moves.go` (`MarketMovesStore`) |
| Write core | `services/shorts/internal/services/shorts/market_moves.go` (`PublishMarketMove`, `RetractMarketMove`), rules in `market_moves_validate.go` |
| HTTP door | `market_moves_http.go`: `POST /v1/market-moves`, `POST /v1/market-moves/retract` |
| Tokens | `market_moves_tokens` (same migration); `market_moves_tokens.go` (mint, verify, the `/api/admin/market-moves/tokens` routes); store `postgres_market_moves_tokens.go`; console `web/src/app/admin/market-moves/` with actions `web/src/app/actions/admin/marketMovesTokens.ts` |
| MCP door | `services/shorts/internal/mcp/admin_market_moves.go`: `post_market_move`, `retract_market_move` on `/mcp/admin`, scope `moves:write` |
| Read | `MarketService.ListMarketMoves` (`market.proto`, public, mirrored on `ShortedStocksService`) |
| Revalidation | `market_moves_revalidate.go`: one coalesced ping to the web's `/api/revalidate` per 15 s burst |
| Web | `web/src/app/actions/market-moves/`, `web/src/@/components/market-moves/`, `web/src/app/market-moves/`, `web/src/app/latest-market-moves.tsx`, the stock Overview card |
| Tests | `market_moves_test.go` (rules, HTTP, rpc, MCP parity, revalidation), `market_moves_tokens_test.go` (the console routes, the verifier's cache and refusals), `postgres_market_moves_integration_test.go` (`make test-market-moves-pg`, gates the deploy: moves and tokens, the token cap under concurrent creates), `services/migrations/market_moves.test.mjs`, `scripts/tests/market-moves-infra.test.mjs`, the console's `marketMovesTokens.test.ts` and `tokens-client.test.tsx` |

## What a move is

One of four kinds, each naming what moved:

| `kind` | Subject field | `change_pct` |
|---|---|---|
| `stock` | `stock_code` (an ASX code shorted holds) | required |
| `index` | `index_code` (`X` + 2 to 5 characters: `XJO`, `XSO`, `XEJ`) | required |
| `sector` | `sector` (free text, 2 to 80 characters) | optional |
| `market` | none | optional |

Every move has a `direction` (`up`, `down`, `flat` at most 0.5% either way, or
`mixed`), a `headline` (8 to 140 characters), a `summary` saying why it moved
(20 to 1,200 characters) and `observed_at`, when the poster saw it. Optional:
`related_codes` (up to 10 more ASX codes), `price` (or the index level),
`volume_ratio` (volume against its usual level), up to 6 https `sources`, up to
8 `tags`, `significance` (1 minor to 5 market-wide, default 3), and `model`
and `run_id` for provenance.

## The rules, and why

The poster is a model, so the writer is strict and says everything at once.

- **Every problem is reported in one answer**, field by field (`422
  invalid_move` with `fields[]`). A poster that learns one mistake per round
  trip wastes its budget rediscovering the rest.
- **Withhold rather than guess.** A code shorted does not hold (neither a
  `company-metadata` row nor a stock price) is refused, in `stock_code` and in
  `related_codes` alike. A `direction` that contradicts its own `change_pct` is
  refused. Nothing is corrected or dropped in silence: a correction would
  publish what the poster did not say.
- **The body is decoded strictly.** An unknown field is a `400`, so `changePct`
  for `change_pct` fails loudly instead of publishing a move without its figure.
- **A missing figure is absent, never 0.** `change_pct`, `price` and
  `volume_ratio` are nullable end to end (`has_*` on the wire, `null` in the web
  view, left out of the card).
- **Plain text only.** Headline and summary are drawn as text (line breaks
  kept), never as HTML or markdown. Control and format characters (a bidi
  override can make a headline read differently from what is stored) are
  refused.
- **Sources are https on a public host**: no credentials, no IP literal, no
  `localhost`, `.local` or `.internal`. They render with
  `rel="nofollow noopener noreferrer ugc"`.
- **A move is news.** `observed_at` more than 5 minutes ahead of the server or
  more than 72 hours old is refused. The move is filed under the Sydney date of
  `observed_at` (`market_date`), and every surface prints the observation time
  beside the move, never one page-level "as at".

## Keys, revisions and retractions

`move_key` is the poster's own name for a move: 3 to 128 characters of
`a-z 0-9 . _ : -`, for example `2026-11-07:bhp:iron-ore`. Pick it so the same
move gets the same key on the next run.

- **Posting a key again revises the move in place.** `revision` goes up by one
  and the surfaces show "Updated". This is how "BHP up 3% at noon" becomes
  "BHP closes up 5.1%" without a second card.
- **Posting identical content again changes nothing** (`200 unchanged`). The
  content hash covers everything a reader sees; `run_id` is not part of it, so
  the next run re-posting the same move is a no-op.
- **The subject cannot change under a key** (`409 subject_changed`): a different
  kind, stock, index or sector is a different move and needs its own key.
- **A retraction is final.** `POST /v1/market-moves/retract` hides the move
  everywhere; the row stays with its time and reason for the audit trail, and
  the key can never be posted again (`409 retracted`). Post the corrected move
  under a new key. Retracting twice is a no-op.
- **Caps**: 300 moves per `market_date` and 100 revisions per move
  (`MARKET_MOVES_MAX_PER_DAY`, `MARKET_MOVES_MAX_REVISIONS` on the API override
  them). A revision does not count against the daily cap. The caps are a guard
  against a runaway workflow, not an exact quota: two concurrent first posts at
  the cap can both land.

## Posting over HTTP

```bash
curl -sS https://api.shorted.com.au/v1/market-moves \
  -H "Authorization: Bearer $SHORTED_MARKET_MOVES_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "move_key": "2026-11-07:bhp:iron-ore",
    "kind": "stock",
    "stock_code": "BHP",
    "related_codes": ["RIO", "FMG"],
    "direction": "up",
    "change_pct": 4.2,
    "price": 45.10,
    "volume_ratio": 2.1,
    "headline": "BHP jumps 4.2% as iron ore rallies on China stimulus",
    "summary": "Iron ore futures rose 6% overnight after Beijing announced new property support.\n\nRio Tinto and Fortescue followed.",
    "sources": [{"title": "Iron ore jumps on stimulus", "url": "https://www.example.com/iron-ore", "publisher": "Example"}],
    "tags": ["iron-ore", "china"],
    "significance": 3,
    "observed_at": "2026-11-07T14:05:00+11:00",
    "model": "claude-opus-5-5",
    "run_id": "market-moves-2026-11-07T03:05Z"
  }'
```

`scripts/market-moves/post-move.sh` does the same from a file or stdin.

| Status | `outcome` / `error` | Meaning |
|---|---|---|
| `201` | `created` | A new move, live now |
| `200` | `updated` / `unchanged` | A revision, or the same content again |
| `400` | `bad_json` | Not one JSON object, or an unknown field |
| `401` | | No credential, or the wrong one |
| `404` | `not_found` | Retract: no move has that key |
| `409` | `retracted`, `subject_changed` | The key is retracted, or a re-post changed its subject |
| `409` | `busy` (`retryable: true`) | Two first posts of one key landed together: send it again |
| `413`, `415` | `too_large`, `unsupported_media_type` | Over 64 KB, or not `application/json` |
| `422` | `invalid_move` | Every field at fault, in `fields[]` |
| `429` | `daily_cap`, `revision_cap` | A cap above |
| `503` | `unavailable` (`retryable: true`, `Retry-After: 5`) | The store is unreachable or the table is missing; nothing was written |

A success answers `{outcome, status, url, move}`: `move` is the public shape
`ListMarketMoves` serves (proto field names), and `url` is the move's anchor on
`https://shorted.com.au/market-moves#move-<move_key>`.

Retract:

```bash
curl -sS https://api.shorted.com.au/v1/market-moves/retract \
  -H "Authorization: Bearer $SHORTED_MARKET_MOVES_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"move_key": "2026-11-07:bhp:iron-ore", "reason": "wrong close"}'
```

### The credential

An administrator creates the token in the admin console: **`/admin/market-moves`**
(the account menu's "Admin: Market moves tokens"). Name it after what will use
it, pick an expiry (30 days, 90, a year or never) and create it. The token,
`smm_` and 43 characters, is shown **once**, with a copy button and the
example request; Shorted stores only its SHA-256 and its first ten characters,
so nothing can show it again. A lost token is revoked and replaced.

Give the token to the workflow's environment as `SHORTED_MARKET_MOVES_TOKEN`
(a Claude Code routine's environment variables, a GitHub Actions secret, a
Cuttlefish project secret). Never put it in a prompt, a repository file or a
commit. Send it as `Authorization: Bearer`: that also puts the workflow in the
edge worker's per-token bucket (100 per 10 s) rather than the anonymous per-IP
one (10 per 10 s). `x-market-moves-token` works too.

- **What a token can do**: post and retract moves on the two routes above, and
  nothing else. It cannot reach the console's routes, the admin API or any rpc.
  The `INTERNAL_SERVICE_SECRET` is accepted on the posting routes as a superset,
  as it is on `/api/admin/news/publish`.
- **The console** lists every token by prefix with its status (active,
  expired, revoked), who created it, when it was last used (recorded at most
  once a minute) and when it expires. At most 10 are active at once.
- **Revoking** is one click and a confirm in the row. The API instance that
  revokes forgets the token at once; every other instance refuses it within 30
  seconds (each caches a lookup that long). A revoked token keeps its row.
- **Audit**: every post records its actor: `token:<id>` for a token (the id
  the console lists), `oauth:<uid>` for the admin connector, `internal` for the
  secret. The API logs a token's creation and revocation by prefix and id,
  never the token.
- **Rotating**: create the new token, give it to the workflow, then revoke the
  old one. There is no gap.
- **Turning posting off**: revoke the workflow's token. The read side keeps
  serving what is published.

A token that cannot be checked (the database unreachable, or a deployment
without 000160) is answered `503 unavailable` with `Retry-After`, never `401`:
the token may be good, and a 401 tells a workflow to give up on it.

The console's routes, behind the internal secret (the console's server actions
call them with `x-admin-actor` set to the verified admin's address):

| Route | |
|---|---|
| `GET /api/admin/market-moves/tokens` | `{tokens: [...], max_active}`: never a token or a hash |
| `POST /api/admin/market-moves/tokens` `{name, expires_in_days}` | `201 {token, meta}`: the only answer that carries the token. `expires_in_days` 0 (never) to 730; `409 token_cap` at 10 active |
| `POST /api/admin/market-moves/tokens/revoke` `{id}` | `200 {meta}`; `404` for an unknown id; idempotent |

## Posting from the admin connector

A Claude session that already has the Shorted admin connector
(`https://api.shorted.com.au/mcp/admin`) can call `post_market_move` and
`retract_market_move` instead. They take the same fields (the tool input and the
HTTP body are held together by `TestMarketMoveToolInputMatchesTheHTTPBody`), go
through the same core, and record the actor as `oauth:<uid>`. They need the
`moves:write` scope: a connector authorised before the scope existed answers
with a tool error naming it until it is disconnected and connected again. A
refusal comes back as a tool error listing every field.

## Reading moves

`MarketService.ListMarketMoves` (public, no credential):

| Field | |
|---|---|
| `stock_code` | Moves about the stock or naming it in `related_codes` |
| `kind` | `stock`, `index`, `sector`, `market` |
| `market_date` | `YYYY-MM-DD`, Sydney |
| `min_significance` | 1 to 5 |
| `limit` | Default 20, at most 100 |
| `cursor` | `next_cursor` from the previous page |

Published moves only, newest `observed_at` first, keyset-paged. The answer never
carries the actor, the run id, the content hash or a retraction's reason. A
database without 000160 answers an empty list.

```bash
curl -sS https://api.shorted.com.au/shorts.v1alpha1.MarketService/ListMarketMoves \
  -H "Content-Type: application/json" -d '{"stockCode": "BHP", "limit": 5}'
```

## How the pages stay fresh

| Surface | Read | Tag | ISR |
|---|---|---|---|
| `/market-moves` | the newest 50 | `market-moves` | 300 s |
| Homepage strip | the newest 4 with significance 3 or more | `market-moves:home` | the page's 24 h |
| Stock Overview card | the newest 5 naming the stock | `market-moves:stock:<CODE>` | the tab's 1 h |

After a post that changes something (not `unchanged`) or a retraction, the API
adds those tags and the paths `/`, `/market-moves` and `/shorts/<CODE>` (for
every code the move names) to a 15-second window, then sends one
`POST /api/revalidate?tag=...&path=...` for the whole burst. The ping is best
effort: it never fails a post, and with `REVALIDATION_URL` or
`REVALIDATION_SECRET` unset nothing is sent and the pages catch up on their ISR
windows. Each read is bounded (about 4 s) and a failed read renders nothing, so
a moves outage never takes a page down.

## Writing the workflow

The workflow decides what is a move; shorted decides what it will publish. A
good loop, every 15 to 30 minutes in ASX hours and once after the close:

1. Read the market: the public Shorted MCP (`get_market_snapshot`,
   `get_stock_prices`, `list_top_shorts`, `get_stock_news`), ASX announcements
   and the news.
2. For each move worth a reader's attention, build one JSON body. Key it
   `<Sydney date>:<subject>:<theme>` so the next run revises it rather than
   adding a duplicate.
3. Post it. On `422`, fix every listed field and post again; on `409 busy` or
   `503`, wait and post again; on `409 retracted`, use a new key.
4. When a later read shows a move was wrong, retract it and post the correction
   under a new key.

Things that will be refused, so do not send them: a code the poster is not sure
of (leave it out of `related_codes`), a figure it does not have (leave it out,
never 0), a `direction` that disagrees with `change_pct`, a non-https source,
and a move it observed more than 72 hours ago.

## Landmines

- **000160 is allowlisted, not hand-applied.** The deploy replays it above the
  000138 closer; the readers answer empty and the writer `503` until it lands.
- **A token is not the internal secret, and opens only the posting routes.**
  Only `market_moves_http.go` verifies one; the console's routes take the
  internal secret alone. `scripts/tests/market-moves-infra.test.mjs` fails if
  another route starts accepting a token, or if a token is read from Terraform or
  the environment again.
- **A token is shown once.** Nothing stores it: not the API (a hash), not the
  console (the reveal panel drops it from state), not a log (prefix and id
  only). Do not add a "show token" feature; revoke and create instead.
- **The tags are a contract between two layers.** The API pings
  `market-moves`, `market-moves:home` and `market-moves:stock:<CODE>`
  (`market_moves_revalidate.go`); the web reads under the same three. Rename one
  side and the pages silently fall back to their ISR windows.
- **A retraction never deletes.** Readers filter `status = 'published'`; a
  `DELETE` by hand would free the key for reuse and lose the audit trail.
- **The stock card is outside the Overview's critical path**: its read is
  bounded and resolves to nothing on failure, and the card renders nothing when
  the stock has no moves, so a page never holds a place it gives back.
