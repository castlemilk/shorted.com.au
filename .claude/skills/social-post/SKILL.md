---
name: social-post
description: Compose and post full-stack social posts to @shorted___ on X — text + X-card link preview + generated infographic. Wraps the Twitter bot, /api/og/twitter PNG endpoint, and /news/[slug] editorial pages. Use when the user says "post a tweet", "tweet today's shorts", "share to X", "social post", "compose a tweet about $TICKER", or "/social-post".
allowed-tools: Read, Write, Bash(npx tsx:*), Bash(curl:*), Bash(gh:*), Edit, Grep, Glob
---

# Social Post — Full-Stack X Pipeline

This skill posts data-rich tweets to `@shorted___` that include:
- a card preview when the tweet URL is a `shorted.com.au` page with og/twitter meta
- a generated PNG infographic (via `/api/og/twitter/[type]`) attached as media
- when relevant, a link to a `/news/[slug]` "Shorted Take" editorial page so the share-back loop stays on shorted.com.au

Source: `scripts/twitter/` (the bot). See `scripts/twitter/OPERATIONS.md` for the production runbook.

## Quick reference

```bash
cd scripts/twitter

# Preview (dry-run, default)
npx tsx src/index.ts daily-shorts
npx tsx src/index.ts movers
npx tsx src/index.ts stock-of-the-day
npx tsx src/index.ts weekly-digest
npx tsx src/index.ts breaking-news
npx tsx src/index.ts insider-trade --stock=BHP

# Post live
npx tsx src/index.ts daily-shorts --live

# Skip infographic (text + card only)
npx tsx src/index.ts daily-shorts --live --no-image
```

`TWITTER_DRY_RUN_DEFAULT=true` in `.env` is the safety net — `--live` is required to actually post.

## When to use this skill

- The user asks for a specific post: "tweet today's top shorts" → run `daily-shorts`
- The user wants to share a stock-specific story: "post about $LOT lithium news" → consider `breaking-news` (auto-finds the latest) or `insider-trade --stock=LOT`
- The user asks to compose an ad-hoc tweet: gather the angle, propose copy + destination URL + infographic option, **always** dry-run first, then ask before `--live`

## The pipeline (what happens under the hood)

1. **Text** — `templates.ts` `buildXxxTweet()` calls the public shorted.com.au API, formats data into ≤280 chars, includes a canonical URL on its own line so X parses it for the card.
2. **Card preview** — when the URL is `shorted.com.au/<path>`, X fetches the page, reads `og:image` + `twitter:card`, renders a large image card.
   Verified-good destinations (cards work today): `/top`, `/shorts/[code]`, `/shorts/[code]/news`, `/reports/weekly/[slug]`, `/insider-trading/[code]`, `/news/[slug]`.
3. **Infographic** (optional) — bot calls `/api/og/twitter/[type]` on shorted.com.au, gets a 1200×675 PNG, uploads to X via `v2.uploadMedia`, attaches as media.
   Variants live: `top-shorts`, `stock-of-day`. More can be added in `web/src/app/api/og/twitter/[type]/route.tsx`.

## Composing an ad-hoc post

When the user asks for a tweet that isn't one of the canned commands:

1. **Pick the angle.** One headline, one stock, one chart — never more.
2. **Pick the destination URL** — must be a `shorted.com.au` page so the card renders:
   - Stock-specific → `https://shorted.com.au/shorts/[CODE]`
   - News → `https://shorted.com.au/shorts/[CODE]/news` or `/news/[slug]` if a Shorted Take exists
   - Sector → `https://shorted.com.au/industry/[slug]`
   - Aggregate → `https://shorted.com.au/top`
3. **Check the destination is live** with a quick curl:
   ```bash
   curl -sI -A "Mozilla/5.0" "https://shorted.com.au/<path>" | head -1
   ```
   Should be `HTTP/2 200`.
4. **Verify card meta** is present:
   ```bash
   curl -sL -A "Mozilla/5.0" "https://shorted.com.au/<path>" | grep -oE 'twitter:(card|image)[^>]*' | head -2
   ```
   `twitter:card content="summary_large_image"` + `twitter:image` URL ⇒ card will render.
5. **Pick or generate an infographic** — for ad-hoc posts use an existing PNG variant. If a new variant is needed, edit `web/src/app/api/og/twitter/[type]/route.tsx`.
6. **Draft tweet copy** — respect the **X 1-cashtag limit**: at most one `$TICKER` per post. Lists of tickers must be plain `JEME / BBAB / LOT` without `$`.
7. **Dry-run first**:
   ```bash
   npx tsx src/index.ts <command>
   ```
8. **Show the user the preview** and ask before `--live`.

## Authoring a new "Shorted Take" for an ad-hoc post

If the user wants the bot's tweet to link to a fresh editorial article on shorted.com.au (not just a stock page):

1. Pick the source headline from `news_articles` (price-sensitive, recent).
2. Write a 150–250 word editorial body in markdown — analytical commentary, not a rehash of the article.
3. Insert into `editorial_takes`:
   ```sql
   INSERT INTO editorial_takes (slug, headline, stock_code, body_md, sentiment,
     source_article_id, source_url, source_name, published_at, model)
   VALUES ($slug, $headline, $stock_code, $body_md, $sentiment,
     $source_id, $source_url, $source_name, NOW(), 'manual');
   ```
   Slug is kebab-case `stock-code-short-summary` (≤80 chars).
4. Wait ~30 sec for Vercel cache (revalidate=600) or hit `/api/revalidate?path=/news/$slug`.
5. Verify: `curl -sI "https://shorted.com.au/news/$slug" | head -1` → 200.
6. Tweet linking to that URL via the bot.

## Gotchas

- **Cashtag limit.** X rejects posts with >1 `$TICKER` (`detail: 'Posts are limited to a maximum of one cashtag'`). Templates already comply — don't reintroduce `$` in list contexts.
- **OAuth `media.write` scope.** Initial bootstrap missed this. Media upload returns 403 until the refresh token is re-minted with `media.write`. Run once:
  ```bash
  npx tsx src/index.ts bootstrap-oauth2
  ```
- **Refresh-token rotation.** X mints a new refresh token on every API call; the bot writes it back to repo-root `.env`. Local cron handles this. CI needs the PAT path documented in `scripts/twitter/OPERATIONS.md` §2.2.
- **Edge worker 1101.** `api.shorted.com.au` intermittently returns Cloudflare worker exceptions. The bot's `shorted-api.ts` retries 5xx 4× with linear backoff. The `/api/og/twitter/*` endpoint does the same. If you see consistent 1101, investigate `services/edge-worker/worker.js` (most recent regression was the hot-cache key bug fixed in PR #139).
- **Infographic fetch fails silently.** When the PNG endpoint returns 404 or <1KB, the bot logs a warning and posts text-only. Check `npm run dev` is live (locally) or that the page is deployed (prod).
- **X account credits.** If X returns `CreditsDepleted`, the developer account is out of monthly post credits. Top up at developer.twitter.com.

## Key files

| File | Purpose |
|---|---|
| `scripts/twitter/src/index.ts` | CLI entry — commands, flags, dispatch |
| `scripts/twitter/src/templates.ts` | Tweet text generators |
| `scripts/twitter/src/twitter-client.ts` | X API wrapper, OAuth 2.0 + 1.0a + DryRun |
| `scripts/twitter/src/shorted-api.ts` | Public API client with 5xx retry |
| `web/src/app/api/og/twitter/[type]/route.tsx` | PNG infographic endpoint |
| `web/src/app/news/[slug]/page.tsx` | Shorted Take editorial page |
| `web/src/app/news/[slug]/opengraph-image.tsx` | Take OG card |
| `services/migrations/000034_editorial_takes.up.sql` | DB schema |
| `scripts/twitter/PROFILE.md` | Brand voice, handle, bio |
| `scripts/twitter/OPERATIONS.md` | Production runbook (cron, secrets) |
| `docs/plans/twitter-fullstack-social.md` | Roadmap for L2/L3 work still pending |

## Brand voice (from `PROFILE.md`)

- Cash, data, transparency. No financial advice ever.
- Cite ASIC + T+4 delay disclaimer in posts that surface short-position data.
- Plain-English, sparse emoji (🔴/🟢/📊/🏆 only), no exclamation marks.
- Stock codes uppercase, no `$` prefix in lists (cashtag limit).
- Always ends with the canonical shorted.com.au URL on its own line.
