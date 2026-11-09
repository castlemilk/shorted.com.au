# Shorted market moves posting API

How a workflow posts market moves to Shorted. A move is published at once on
https://shorted.com.au/market-moves, in the homepage strip and on the Overview
tab of every stock it names. The /market-moves page says the moves are written
by an AI workflow; the cards themselves name no author.

PRIVATE: from the Shorted admin console (/admin/api-docs). The full design
record is `docs/feature/market-moves/README.md` in the repository.

## Base URL and authentication

```
https://api.shorted.com.au
```

Every write needs a market-moves token, created by an administrator at
https://shorted.com.au/admin/market-moves. A token starts `smm_`, is shown once
when it is created, and can post and retract moves and nothing else. Read it
from the environment (`SHORTED_MARKET_MOVES_TOKEN`), never from a prompt or a
file, and send it as:

```
Authorization: Bearer <token>
```

A revoked or expired token answers `401 unauthorized`: stop and ask for a new
one. Revocation takes effect within 30 seconds.

## POST /v1/market-moves

Posts one move, or revises it. JSON body, `Content-Type: application/json`, at
most 64 KB. Unknown fields are refused (`400`), so spell every field exactly
as below.

| Field | Type | Required | Rule |
| --- | --- | --- | --- |
| `move_key` | string | yes | Your own key for the move: 3 to 128 characters of `a-z 0-9 . _ : -`, starting with a letter or digit. Use `<Sydney date>:<subject>:<theme>`, e.g. `2026-11-07:bhp:iron-ore`, so the next run revises the move instead of adding a duplicate. |
| `kind` | string | yes | `stock`, `index`, `sector` or `market`. |
| `stock_code` | string | for `stock` only | An ASX code Shorted holds, e.g. `BHP`. |
| `index_code` | string | for `index` only | `X` and 2 to 5 letters or digits, e.g. `XJO`, `XSO`, `XEJ`. |
| `sector` | string | for `sector` only | 2 to 80 characters, e.g. `Materials`. |
| `related_codes` | string[] | no | Up to 10 more ASX codes the move names. Each must be a code Shorted holds; leave out any you are not sure of. |
| `direction` | string | yes | `up`, `down`, `flat` (at most 0.5% either way) or `mixed`. Must agree with `change_pct`. |
| `change_pct` | number | for `stock` and `index` | The move in percent: `-3.2` is a 3.2% fall. Between -100 and 1000. Leave it out when you do not know it; never send 0 for unknown. |
| `price` | number | no | The price, or the index level, at `observed_at`. Positive. |
| `volume_ratio` | number | no | Volume against its usual level: `2.5` is two and a half times. |
| `headline` | string | yes | 8 to 140 characters of plain text: what moved and by how much. |
| `summary` | string | yes | 20 to 1,200 characters of plain text saying why it moved. Line breaks are kept; markdown and HTML are shown as typed. |
| `sources` | object[] | no | Up to 6 `{ "title", "url", "publisher"? }`. `url` must be `https` on a public host (no IP address, no credentials). |
| `tags` | string[] | no | Up to 8 of `a-z 0-9 -`, e.g. `iron-ore`. |
| `significance` | integer | no | 1 (minor) to 5 (a market-wide event). Default 3. The homepage shows 3 and above. |
| `observed_at` | string | yes | When you observed the move: RFC 3339 with an offset, e.g. `2026-11-07T14:05:00+11:00`. Not more than 5 minutes ahead of Shorted's clock and not more than 72 hours ago. The move is filed under the Sydney date of this time. |
| `model` | string | no | The model writing the move, e.g. `claude-opus-5-5`. Shown beside the move. |
| `run_id` | string | no | Your run's id, for the audit log. Not shown. |

Example:

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

### Revising, repeating and retracting

- **The same `move_key` again revises the move in place**: its `revision`
  goes up and the site shows "Updated". Post the closing figure under the key
  of the intraday move.
- **Identical content again changes nothing** (`200 unchanged`). `run_id` is
  not part of the comparison, so re-posting the same move each run is safe.
- **The subject cannot change under a key** (`409 subject_changed`). A
  different stock, index, sector or kind is a different move: use a new key.
- **A retracted key cannot be posted again** (`409 retracted`). Post the
  correction under a new key.
- **Caps**: 300 new moves per Sydney date and 100 revisions per move
  (`429 daily_cap`, `429 revision_cap`). A revision does not count as a new
  move.

### Answers

A success is `{ "outcome", "status", "url", "move" }`. `outcome` is `created`
(`201`), `updated` or `unchanged` (`200`); `url` is the move on
https://shorted.com.au/market-moves; `move` is the move as published.

| Status | `error` | What to do |
| --- | --- | --- |
| `201`, `200` | | Done. |
| `400` | `bad_json` | Fix the body: one JSON object, only the fields above. |
| `401` | `unauthorized` | The token is missing, revoked or expired. Stop; do not retry. |
| `404` | `not_found` | (Retract) No move has that key. |
| `409` | `subject_changed`, `retracted` | Use a new `move_key`. |
| `409` | `busy` (`retryable: true`) | Another post of the same new key landed together. Send it again. |
| `413`, `415` | `too_large`, `unsupported_media_type` | Shrink the body, or send `application/json`. |
| `422` | `invalid_move` | `fields` lists every field at fault with its rule. Fix them all and post again. |
| `429` | `daily_cap`, `revision_cap` | Stop adding moves today; revise existing ones. |
| `503` | `unavailable` (`retryable: true`, `Retry-After`) | Nothing was written. Wait the `Retry-After` seconds and send it again. |

Retry only `409 busy` and `503`, with a delay. Every other refusal comes back
the same until the request changes.

## POST /v1/market-moves/retract

Takes a move off the site. Final: its key cannot be posted again.
Retracting twice changes nothing.

| Field | Type | Required | Rule |
| --- | --- | --- | --- |
| `move_key` | string | yes | The key the move was posted with. |
| `reason` | string | no | Up to 280 characters. Recorded, not shown. |

```bash
curl -sS https://api.shorted.com.au/v1/market-moves/retract \
  -H "Authorization: Bearer $SHORTED_MARKET_MOVES_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"move_key": "2026-11-07:bhp:iron-ore", "reason": "wrong close"}'
```

## Reading moves: MarketService/ListMarketMoves

Public, no token needed. Use it to see what is already posted before a run
posts again. Published moves only, newest `observed_at` first.

```bash
curl -sS https://api.shorted.com.au/shorts.v1alpha1.MarketService/ListMarketMoves \
  -A 'my-workflow/1.0' \
  -H 'Content-Type: application/json' \
  -H 'Connect-Protocol-Version: 1' \
  -d '{"marketDate": "2026-11-07", "limit": 100}'
```

| Field | Type | Rule |
| --- | --- | --- |
| `stockCode` | string | Moves about the stock, or naming it in `related_codes`. |
| `kind` | string | `stock`, `index`, `sector` or `market`. |
| `marketDate` | string | `YYYY-MM-DD`, Sydney. |
| `minSignificance` | integer | 1 to 5. |
| `limit` | integer | Default 20, at most 100. |
| `cursor` | string | `nextCursor` from the previous answer. |

The answer is `{ "moves": [...], "nextCursor"? }`. A figure Shorted was not
given travels with `has*` false (`hasChangePct`, `hasPrice`,
`hasVolumeRatio`), never as a real 0. Send a `User-Agent` of your own: a bare
`curl` agent is refused on the rpc routes.

## What a good run does

1. Read the market (prices, announcements, news) and what is already posted
   today (`ListMarketMoves` with today's `marketDate`).
2. For each move worth a reader's attention, build one body. Key it so the
   next run revises it.
3. Post it. On `422`, fix every listed field and post again. On `409 busy` or
   `503`, wait and post again. On `401`, stop.
4. When a later read shows a posted move was wrong, retract it and post the
   correction under a new key.

Never send a code you are not sure of, a figure you do not have, a
`direction` that disagrees with `change_pct`, a non-https source, or a move
observed more than 72 hours ago: each is refused.
