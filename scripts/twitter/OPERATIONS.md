# Twitter / X bot — operations runbook

How to bootstrap, schedule, monitor, and modify the @shorted___ Twitter
automation. Companion to:

- [`PROFILE.md`](PROFILE.md) — account branding (handle, bio, visuals)
- [`README.md`](README.md) — local dev quickstart

The bot is a Node.js + TypeScript script that runs either locally
(during dev) or as a scheduled **GitHub Actions** job (in production —
`.github/workflows/twitter-bot.yml`).

---

## 1. Bootstrap (one-time)

### 1.1 Register the @shorted___ account

Follow the activation checklist at the bottom of
[`PROFILE.md`](PROFILE.md). You need a verified X account before
anything else.

### 1.2 Create an X developer app

1. Go to [developer.x.com](https://developer.x.com) and sign in as
   the @shorted___ account.
2. Apply for a **Free** developer account (sufficient for 17 posts /
   24h — covers the cadence below with headroom).
3. Create a Project → create an App inside it.
4. In **User authentication settings**, set:
   - **App permissions**: Read and Write
   - **Type of App**: Web App, Automated App or Bot
   - **Callback URI**: `https://shorted.com.au` (placeholder, not used)
   - **Website URL**: `https://shorted.com.au`
5. Under **Keys and tokens**, generate **all four** OAuth 1.0a values:

   | Field | Where to store |
   |---|---|
   | API Key (consumer key) | `TWITTER_API_KEY` |
   | API Secret (consumer secret) | `TWITTER_API_SECRET` |
   | Access Token | `TWITTER_ACCESS_TOKEN` |
   | Access Token Secret | `TWITTER_ACCESS_TOKEN_SECRET` |

   ⚠️ Generate **Access Tokens with Read AND Write permissions** —
   the regenerate button shows the current scope. If yours says
   "Read only", regenerate after fixing the App permissions in step 4.

### 1.3 Add secrets to GitHub Actions

Repo Settings → Secrets and variables → Actions → New repository
secret. Add the four values from 1.2.

Verify with the GitHub CLI:

```bash
gh secret list --repo castlemilk/shorted.com.au | grep TWITTER
```

Should list all four `TWITTER_*` names (values won't display).

### 1.4 First dry-run from GitHub Actions

1. Open https://github.com/castlemilk/shorted.com.au/actions/workflows/twitter-bot.yml
2. Click **Run workflow** in the top-right
3. Pick `command=daily-shorts`, `mode=dry-run`
4. Wait ~30 seconds; the run logs should show a generated tweet
   with `[DRY RUN] would tweet` (no actual post made)

### 1.5 First live post

Same workflow, but pick `mode=live`. Confirm the tweet lands at
`https://x.com/shorted`. After this, the scheduled cron jobs will
start posting automatically per the cadence below.

---

## 2. Production schedule (local cron)

Runs from your local machine via cron / launchd. CI scheduling is
opt-in (see §2.2).

### 2.1 Cron file

All times below are **UTC**; AEST is +10 (or +11 in daylight-saving).

| Cron | Command | AEST | AEDT |
|---|---|---|---|
| `0 1 * * *` | `daily-shorts` | 11:00 | 12:00 |
| `30 6 * * *` | `movers` | 16:30 (post-close) | 17:30 |
| `0 23 * * *` | `stock-of-the-day` | 09:00 next day | 10:00 |
| `0 7 * * 5` | `weekly-digest` | 17:00 Fri | 18:00 Fri |
| `0 0,2,4,6 * * 1-5` | `breaking-news` (every 2h during market hours) | 10:00–16:00 | +1h |
| `30 0 * * 1-5` | `squeeze-alert` — **disabled until `GetBattlegroundStocks` is deployed to prod** (no-ops gracefully until then) | 10:30 Mon–Fri | 11:30 |

Drop into `crontab -e`:

```cron
SHELL=/bin/bash
REPO=/Users/<you>/projects/shorted
LOG=/tmp/shorted-twitter.log

0 1 * * *           cd $REPO/scripts/twitter && /usr/local/bin/npx tsx src/index.ts daily-shorts --live      >> $LOG 2>&1
30 6 * * *          cd $REPO/scripts/twitter && /usr/local/bin/npx tsx src/index.ts movers --live            >> $LOG 2>&1
0 23 * * *          cd $REPO/scripts/twitter && /usr/local/bin/npx tsx src/index.ts stock-of-the-day --live  >> $LOG 2>&1
0 7 * * 5           cd $REPO/scripts/twitter && /usr/local/bin/npx tsx src/index.ts weekly-digest --live     >> $LOG 2>&1
0 0,2,4,6 * * 1-5   cd $REPO/scripts/twitter && /usr/local/bin/npx tsx src/index.ts breaking-news --live     >> $LOG 2>&1

# ⚠️ ENABLE ONLY AFTER `GetBattlegroundStocks` IS DEPLOYED TO PROD.
# Until then this command no-ops (prints "endpoint unavailable" and exits 0),
# so leaving it off just avoids noise in the log. squeeze-alert dedups any
# code alerted in the last 72h and posts at most one cashtag per tweet.
# 30 0 * * 1-5      cd $REPO/scripts/twitter && /usr/local/bin/npx tsx src/index.ts squeeze-alert --live     >> $LOG 2>&1
```

Tail logs: `tail -f /tmp/shorted-twitter.log`

### 2.2 Switching local cron → GitHub Actions (later)

The workflow at `.github/workflows/twitter-bot.yml` runs **manual
only** via `workflow_dispatch` today. To enable scheduled CI:

1. Uncomment the `schedule:` block at the top of the workflow file
2. Add GH Actions secrets: `TWITTER_CLIENT_ID`, `TWITTER_CLIENT_SECRET`,
   `TWITTER_REFRESH_TOKEN` (from local `bootstrap-oauth2`)
3. Add a fine-grained PAT at https://github.com/settings/personal-access-tokens/new
   with `Secrets: Read and write` scope, save as `GH_PAT_FOR_SECRETS`
4. Append a step that re-stores the rotated refresh token (X rotates
   on every use). See the workflow file's trailing comment block.
5. Disable local cron

The local-cron flow has a real advantage: the rotated refresh token
persists to `.env` automatically — no PAT plumbing required.

Schedule changes? Edit `.github/workflows/twitter-bot.yml` and add a
corresponding case to the `determine-command` step.

---

## 3. Daily ops

### 3.1 Where logs live

Every run is visible at:
https://github.com/castlemilk/shorted.com.au/actions/workflows/twitter-bot.yml

Each run shows:
- The resolved command + mode
- Generated tweet body
- Posted tweet ID (or dry-run marker)
- Any API errors

### 3.2 What to watch for

| Signal | Action |
|---|---|
| `dry_run=true` in production | Check `TWITTER_DRY_RUN_DEFAULT` isn't being overridden somewhere |
| `429 Too Many Requests` | X rate limit hit. Free tier = 17 posts/24h. Trim a cadence. |
| `Tweet too long` exception | A template generated >280 chars. Tweak `templates.ts` to trim. |
| WAF error from shorted API | Cloudflare blocked the bot's IP burst. Reduce concurrent fetches. |
| Empty response from `breaking-news` | Normal — means no qualifying price-sensitive news. |

### 3.3 Pause posting temporarily

Two options:

1. **Disable a single cron**: edit the workflow, comment out the
   relevant `cron:` line.
2. **Disable the whole bot**: GitHub UI → Actions → Twitter bot →
   `⋯` menu → Disable workflow.

To re-enable: revert the edit or click "Enable workflow".

### 3.4 Roll back a bad tweet

1. Delete the offending tweet manually on X (3-tap from the post).
2. If the tweet template generated bad copy, edit
   `scripts/twitter/src/templates.ts` and ship a PR. Future runs use
   the new template.

### 3.5 Force a one-off post outside the schedule

GitHub Actions → Twitter bot → **Run workflow** → pick command +
`mode=live`. Useful for breaking news outside the 2-hourly sweep.

---

## 4. Modifying the bot

### 4.1 Add a new post type

1. Add a `build*Tweet()` function to `src/templates.ts`
2. Add a `case` in `src/index.ts` `run()` switch
3. Add a `script:` entry in `package.json` (optional, for local use)
4. Add a cron trigger to `.github/workflows/twitter-bot.yml`

### 4.2 Tweak an existing template

Edit the relevant `build*Tweet()` in `src/templates.ts`. Run
locally with `--dry-run` to preview:

```bash
cd scripts/twitter
npx tsx src/index.ts daily-shorts          # dry-run
```

Ship a PR; the next scheduled run uses the new copy.

### 4.3 Change brand voice / style

Edit `src/templates.ts` — that's the only source of post text. The
`SITE` constant at the top controls the URL anchor used everywhere.

### 4.4 Test against staging data

Set `SHORTED_API_URL` to a preview deployment in `.env` (locally)
or as a workflow `env:` override. The script's only data dependency
is that endpoint.

---

## 5. Local development

Prerequisites: Node 22+.

```bash
cd scripts/twitter
npm install
cp .env.example .env       # fill in your X dev-account credentials

# Preview every tweet type — won't post:
npm run post:daily-shorts
npm run post:movers
npm run post:weekly-digest
npm run post:stock-of-the-day
npm run post:breaking-news
npm run post:squeeze-alert   # no-ops until GetBattlegroundStocks ships to prod

# Actually post (BE CAREFUL):
npx tsx src/index.ts daily-shorts --live

# Squeeze alert with a custom score threshold (default 70):
npx tsx src/index.ts squeeze-alert --threshold=80
```

`TWITTER_DRY_RUN_DEFAULT=true` is the safety net — dry-run is
on unless you explicitly pass `--live`.

---

## 6. Compliance reminders

- **Not financial advice** — every data-citing tweet should include
  the source (ASIC, T+4) and avoid recommending trades.
- **Cashtag format** — use `$BHP` not `#BHP` for stock symbols. X
  cashtags route through StockTwits-style aggregators.
- **Attribution** — every data tweet should cite ASIC and link to
  the relevant `shorted.com.au/...` page so readers can verify.
- **AFSL** — purely informational posts about ASIC-published data
  don't trigger AFSL requirements under s911A of the Corporations
  Act, but stay clear of "personal advice" language ("you should
  buy", "best to short", etc.).

---

## 7. Cost & limits

| Tier | Posts/24h | Reads/month | Cost |
|---|---|---|---|
| Free | 17 | 100 | $0 |
| Basic | 100 | 10k | $100/mo |
| Pro | 100/15min | 1M | $5,000/mo |

Current schedule uses ~7-12 posts/24h, comfortably within Free.

GitHub Actions: free tier covers more workflow minutes than we'll
ever use. Each tweet job runs ~20-40s.

---

## 8. Where to find things

| File | Purpose |
|---|---|
| `.github/workflows/twitter-bot.yml` | Scheduled GitHub Actions runs |
| `scripts/twitter/src/index.ts` | CLI entry — dispatches commands |
| `scripts/twitter/src/templates.ts` | Tweet text generators |
| `scripts/twitter/src/twitter-client.ts` | X API wrapper + DryRun stub |
| `scripts/twitter/src/shorted-api.ts` | Public shorted.com.au API client |
| `scripts/twitter/.env.example` | Credentials template (local dev) |
| `scripts/twitter/PROFILE.md` | Account branding + content strategy |
| `scripts/twitter/README.md` | Local dev quickstart |
| `scripts/twitter/OPERATIONS.md` | This document |

---

## 9. Troubleshooting

### "401 Unauthorized" from X API

- Your access token doesn't have Write permission. Regenerate
  Access Token + Secret after setting the App to Read+Write.
- Or: clock skew — OAuth 1.0a requires synced wall clock. GitHub
  Actions runners are fine; local Macs sometimes drift.

### "403 Forbidden" from X API

- Tweet contains banned content (link to a flagged URL, repeated
  text, prohibited terms). X's automated filters are opaque — try
  rewording the template.
- Account is suspended/restricted. Check
  https://x.com/settings/your_twitter_data.

### Generated tweet shows "—" instead of data

- `shorted.com.au` API is unreachable. Check
  https://shorted.com.au/health and the GH Actions logs for the
  specific fetch error.
- Stock has no recent data (e.g. delisted). Expected — the bot
  falls back to safe defaults.

### Tweet rendered but `[DRY RUN]` shown in production

- `TWITTER_DRY_RUN_DEFAULT` env var is set to `true` (or not set,
  which defaults to dry-run). Check the workflow's `env:` block.

### Schedule doesn't fire on time

- GitHub Actions cron is **eventually-consistent** — it can drift
  by 5-15 minutes under load. Don't rely on second-precision.
- For tighter timing, run locally via `cron` or `launchd` instead.

---

Last updated: 2026-05-18
