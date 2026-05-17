# Shorted Twitter / X Profile Setup

Copy-paste-ready brand assets and content strategy for the
`@shorted` (or `@shorted_au`) account.

---

## Handle

**Primary**: `@shorted`
**Fallback if taken**: `@shorted_au`, `@shortedasx`, `@shorteddotcom`

The site already references `@shorted` in `web/src/@/config/site.ts` —
keep that consistent.

## Display name

`Shorted — ASX Short Selling`

## Bio (160 chars)

```
Daily ASIC short position data for every ASX-listed stock.
T+4 reporting · short interest trends · price-sensitive news.
Not financial advice.
```

(159 chars including spaces)

## Location

```
Sydney, Australia
```

## Website

```
https://shorted.com.au
```

## Pinned tweet (template)

```
We track ASIC short position reports for every ASX-listed stock.
Daily updates · T+4 reporting · industry breakdowns · sentiment.

Top shorted today: [scrape from /top]
News + insider trades: [link to /news, /insider-trading]

shorted.com.au
```

---

## Visual assets

### Header banner — 1500×500 px

Recommend a wide composition of:
- The top 5 stock codes ($CBA, $BHP, $CSL, etc) over a faint
  price-vs-short overlay chart
- Brand colours: terminal-black `#050607` background with neon
  green `#00FF9C` for short %, cyan `#00E5FF` for price

The site's existing `/opengraph-image` route can serve as a starting
visual — same aesthetic.

### Profile picture — 400×400 px

Either:
1. The Shorted logo (`/public/icon.png`) on a dark background
2. A minimal "S" monogram in terminal-black + amber `#FFA94D`

### Brand colours (mirrors `.impeccable.md` / Cloud Guardian)

| Token | Hex | Usage |
|---|---|---|
| terminal-black | `#050607` | Background, text on light |
| neon-green | `#00FF9C` | Short interest, +sentiment |
| cyan | `#00E5FF` | Price, neutral data |
| amber | `#FFA94D` | Highlights, warnings |
| red | `#FF3B3B` | Big short increases, -sentiment |

---

## Content strategy

### Cadence

| Frequency | Type | Time (AEST) |
|---|---|---|
| Daily | "Most Shorted Today" — top 5 with cashtags | 11:00 |
| Daily | "Biggest Movers" — top weekly-WoW changes | 16:30 (post-close) |
| Weekly (Fri 5pm) | Weekly summary thread → link to /reports/weekly/[slug] | 17:00 Fri |
| Ad-hoc | Breaking news with sentiment chip | within 15min of ingestion |
| Ad-hoc | Major insider trade (>$500k) | within 1hr of ASX filing |

### Content pillars

1. **Data drops** (60%) — numbers people can't get elsewhere
2. **Narrative** (20%) — "why this matters" interpretive threads
3. **Editorial** (15%) — weekly recaps, sector deep-dives
4. **Community** (5%) — replies, RTs of regulatory news, polls

### Tone

- Technical, precise, vigilant (mirrors product brand)
- Always cite ASIC as the source for short numbers
- Never recommend trades — purely informational
- Use cashtags ($CBA, $BHP) so the post is indexed by stock tickers
- Hashtags sparingly: `#ASX` `#ShortSelling` `#ASXShorts`

### Template tweets

**Daily top shorts:**
```
Most shorted ASX stocks today:

1. $XXX  X.XX% ↑0.12
2. $YYY  X.XX% ↓0.05
3. $ZZZ  X.XX% ↑0.03
4. $WWW  X.XX% ↓0.01
5. $VVV  X.XX% =

Source: ASIC (T+4). Live: shorted.com.au/top
```

**Biggest mover:**
```
$XXX short interest jumped +X.X% this week — now the [N]th
most-shorted ASX stock.

Industry: [name]
Days to cover: X.X
Short %: X.X% (was X.X% last week)

Chart: shorted.com.au/shorts/XXX
```

**Breaking news:**
```
$XXX [sentiment emoji]

"[headline]" — [source]

[Optional context line]

Full story + linked /shorts/XXX page on shorted.com.au
```

**Weekly digest (Friday):**
```
ASX short selling — Week W## ##:

🔴 Biggest jumpers: $A $B $C
🟢 Biggest covers: $D $E $F
📊 Industry hot zone: [sector] (avg +X.X%)

Full report → shorted.com.au/reports/weekly/####-W##
```

---

## Automation

See `scripts/twitter/` in this repo for the post-automation script
that consumes ASIC short data + news_articles + director_trades and
posts on the cadence above.

Setup:
```bash
cd scripts/twitter
npm install
cp .env.example .env       # fill in X API credentials
npm run post:daily-shorts
npm run post:movers
npm run post:weekly-digest
```

Run as a local cron (or scheduled GH Action) once credentials are in
place. The script supports `--dry-run` to preview tweets before
posting.

---

## Compliance notes

- **Not financial advice**: include "Not financial advice" or "NFA"
  in tweets that quote specific stocks. Australian Corporations Act
  s911A requires AFSL for personal financial product advice — purely
  informational data tweets don't trigger this, but be explicit.
- **ASIC attribution**: every data tweet should cite ASIC + T+4
  delay. Helps with both legal coverage and AI Overviews citing the
  primary source.
- **Cashtag format**: `$CBA` not `#CBA` — cashtags are the indexed
  form on X for stock symbols and feed into StockTwits-style trackers.

---

## Activation checklist

- [ ] Register `@shorted` (or fallback) on X
- [ ] Upload profile picture (400×400)
- [ ] Upload header banner (1500×500)
- [ ] Bio + location + website
- [ ] Pin the introductory tweet
- [ ] Apply for X Developer account → create app
- [ ] Generate API key + secret + access token + secret (OAuth 1.0a)
  OR OAuth 2.0 client ID + secret with `tweet.write` scope
- [ ] Drop credentials into `scripts/twitter/.env`
- [ ] First dry-run: `cd scripts/twitter && npm run post:daily-shorts -- --dry-run`
- [ ] First live post: `npm run post:daily-shorts`
- [ ] Schedule as cron (Apple Automator, Brew services, or GH Actions)
