# Shorted Twitter / X automation

Local Node.js script that pulls live ASIC short data, market news,
and director trades from the shorted.com.au API and posts curated
tweets on a configurable cadence.

See [`PROFILE.md`](PROFILE.md) for the @shorted account setup
(handle, bio, brand colours, visual assets, content strategy).

---

## Setup

```bash
cd scripts/twitter
npm install
cp .env.example .env
# Edit .env — paste your Twitter / X API credentials
```

### Twitter / X credentials

Easiest path: **OAuth 1.0a** (single-account bot). At
[developer.x.com](https://developer.x.com) create a project + app,
then under "Keys and tokens" generate:

| Field | Env var |
|---|---|
| API Key | `TWITTER_API_KEY` |
| API Secret | `TWITTER_API_SECRET` |
| Access Token | `TWITTER_ACCESS_TOKEN` |
| Access Token Secret | `TWITTER_ACCESS_TOKEN_SECRET` |

The app needs **Read and Write** permissions. Free X tier supports
up to 17 posts / 24h which is plenty for the cadence below.

---

## Commands

All commands default to **dry-run** (prints the tweet, doesn't post).
Pass `--live` to actually post.

```bash
# Preview tweets
npm run post:daily-shorts            # Most-shorted top 5
npm run post:movers                  # Biggest WoW changes
npm run post:stock-of-the-day        # Spotlight on #1 most-shorted
npm run post:weekly-digest           # 4-tweet Friday thread
npm run post:breaking-news           # Latest price-sensitive news

# Actually post (drop --dry-run after npm run)
npx tsx src/index.ts daily-shorts --live
npx tsx src/index.ts movers --live
npx tsx src/index.ts insider-trade --stock=BHP --live
```

### Recommended cadence

| Tweet | When | Cron |
|---|---|---|
| Daily top shorts | Daily 11:00 AEST | `0 1 * * *` (UTC) |
| Biggest movers | Daily 16:30 AEST (post-close) | `30 6 * * *` (UTC) |
| Weekly digest thread | Fri 17:00 AEST | `0 7 * * 5` (UTC) |
| Stock of the day | Daily 09:00 AEST | `0 23 * * *` (UTC, day-prior) |
| Breaking news | Every 30 min during ASX hours | `*/30 0-7 * * 1-5` (UTC) |

---

## Scheduling

### Local (macOS) — Brew + launchd

```bash
# Create a launch daemon: ~/Library/LaunchAgents/com.shorted.twitter.plist
# (see Apple docs for the XML). Point to the absolute path of:
#   /usr/local/bin/npx --prefix /Users/.../scripts/twitter tsx \
#     /Users/.../scripts/twitter/src/index.ts daily-shorts --live
```

### Local (any OS) — cron

```cron
# Daily top shorts at 11:00 AEST (01:00 UTC)
0 1 * * * cd /Users/.../shorted/scripts/twitter && npx tsx src/index.ts daily-shorts --live >> /tmp/shorted-twitter.log 2>&1

# Friday weekly digest at 17:00 AEST (07:00 UTC)
0 7 * * 5 cd /Users/.../shorted/scripts/twitter && npx tsx src/index.ts weekly-digest --live >> /tmp/shorted-twitter.log 2>&1
```

### Cloud — GitHub Actions (production)

The scheduled workflow is already in place:
[`.github/workflows/twitter-bot.yml`](../../.github/workflows/twitter-bot.yml).
It runs all 5 post types on a fixed cron + supports manual one-off
runs via `workflow_dispatch`.

Full bootstrap + ops instructions: [`OPERATIONS.md`](OPERATIONS.md).

---

## Safety

- All commands **default to dry-run**. Set `TWITTER_DRY_RUN_DEFAULT=false`
  in `.env` (or pass `--live`) to actually post.
- Tweets are validated for ≤280 chars before posting; the script
  throws if a generated tweet would exceed.
- The X API enforces rate limits; the script doesn't retry on its
  own — re-run failed jobs manually.

---

## Files

| File | Purpose |
|---|---|
| `src/index.ts` | CLI entry (commands + flags) |
| `src/templates.ts` | Tweet generators (data → text) |
| `src/twitter-client.ts` | X API wrapper + DryRun stub |
| `src/shorted-api.ts` | Public shorted.com.au API client |
| `package.json` | npm scripts + deps (self-contained) |
| `.env.example` | Credentials template |
| `PROFILE.md` | Account branding + strategy |
