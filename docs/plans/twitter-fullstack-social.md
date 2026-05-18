# Twitter Full-Stack Social — Plan

Goal: turn `@shorted___` from text-only tweets into rich social posts with
X-card link previews, generated infographics, and a closed-loop link
strategy back to shorted.com.au editorial pages. Wrap the whole pipeline
in a Claude skill so a single prompt produces a previewable post.

## Why

- Text tweets get ~3-5x lower engagement than tweets with images or cards.
- Linking out to external publishers (current `breaking-news` behaviour)
  leaks attention. Linking to a shorted.com.au editorial page captures
  SEO, traffic, and gives the share-back loop.
- Generated infographics are eye-catching, on-brand, and cheap to make
  with `@vercel/og` (already a Next.js primitive).

## Layer 1 — X-card link previews (free wins, ~half day)

X auto-generates card previews when the destination URL has correct
`og:image` + `twitter:card` meta. Most bot URLs already have OG image
routes — likely already working. Verify and tighten.

**Work**
1. Audit `og:image` / `twitter:card` / `twitter:image` on every URL the
   bot links to: `/top`, `/shorts/[code]`, `/reports/weekly/[slug]`.
2. Re-enable disabled twitter-image routes; add for `/shorts/[code]`
   and `/reports/weekly/[slug]`.
3. Make sure every template puts the URL on its own line so X parses it
   as a card-trigger.

**Validation**: post each command type live to @shorted___, confirm card
renders. Also check https://cards-dev.twitter.com/validator (deprecated
but still works) or post and inspect.

## Layer 2 — Internal article surface (~2-3 days)

Currently `/news` is just an aggregator; articles link out. To keep
share-loop closed, we need shorted.com.au-hosted article pages.

**Two new page types**

| Page | Purpose | Tweet from |
|---|---|---|
| `/news/[stockCode]` | Per-stock news roll-up + sentiment summary | breaking-news, insider-trade |
| `/news/[slug]` | "Shorted Take" — Gemini editorial on a single headline | breaking-news (preferred) |

**DB**: new `editorial_takes` table — `id, slug, headline, stock_code, body_md, source_article_id, sentiment, published_at, og_image_url`.

**Cron**: daily AEST job picks top unprocessed price-sensitive headline,
generates ~200-word Gemini commentary, writes to `editorial_takes`,
publishes (or queues for review).

**Bot change**: `breaking-news` template prefers internal Take URL; falls
back to external publisher if no Take exists yet.

## Layer 3 — Generated infographics (~3-5 days)

PNG endpoint that returns a 1200×675 image for each tweet type, then
attached as media to the tweet.

**Endpoint**: `/api/og/twitter/[type]` — Next.js Route Handler using
`@vercel/og` (Satori). Cached aggressively.

**Variants**:
- `top-shorts` — vertical bar chart of top 5 with %
- `movers` — split-card showing top mover w/ arrow + change
- `stock-of-day` — hero card with ticker, name, %, sector
- `weekly-digest` — summary infographic with top 3, sector heatmap chip
- `sector-heatmap` — industry breakdown

**Twitter client**: extend `twitter-client.ts` with
`postTweetWithMedia(text, pngBuffer)`. Uses twitter-api-v2's
`v1.uploadMedia()` then `v2.tweet({ text, media: { media_ids } })`.
OAuth scopes/auth method TBD — may need OAuth 1.0a fallback for media
upload if PKCE doesn't support it (the client already handles both).

**Template wiring**: each command fetches its infographic, attaches to
tweet. `--no-image` flag for text-only fallback.

## The Skill — `.claude/skills/social-post`

```
/social-post breaking news on $LOT lithium downgrade
/social-post weekly digest for week 2026-W21
/social-post stock-of-day
```

Flow:
1. Parse intent → pick command + destination URL pattern
2. If destination doesn't exist (e.g. no Take written yet) → generate it
   via the Layer 2 pipeline
3. Verify OG meta on destination (curl + parse)
4. Fetch infographic PNG if applicable
5. Build tweet text via existing templates.ts
6. Show preview (text + URL + image) for approval
7. On approval: `npx tsx src/index.ts <cmd> --live`

## Sequencing

L1 first (small, validates the cards story), then L3 (high visual
impact, doesn't depend on L2), then L2 (most code, requires DB
migration + Gemini calls + cron infra). Skill scaffolded after L1
+ L3 land — wraps what exists at each stage.

## Open questions

- Which X auth method supports media upload via twitter-api-v2 v2?
  OAuth 2.0 PKCE works for `v2.tweet`; media upload historically needs
  v1.1 + OAuth 1.0a. Confirm before L3 starts.
- Auto-publish or human-approval queue for "Shorted Take" editorials?
  Editorial content carries reputational risk; lean toward queue.
- Sitemap + RSS inclusion strategy for `/news/[stockCode]` and
  `/news/[slug]` — avoid index bloat for low-value per-stock pages.
