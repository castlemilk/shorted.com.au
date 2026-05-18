# Pre-Post Validation Checklist

Read PERSONA.md first. Then run every item below on the drafted text
before any `--live` post or before publishing a Shorted Take. Failing
any **HARD** gate means rewrite — no exceptions. Failing a **SOFT** gate
means consider rewriting unless you can articulate why the violation
serves the post.

Run the lint helper first to catch the obvious:
```bash
node scripts/twitter/scripts/lint-copy.mjs --text "<paste here>"
```
It greps for banned phrases and flags sentence-length monotony. It
doesn't replace the manual gates — they need judgement.

---

## HARD gates (failing = rewrite)

### 1. Banned AI-isms
Reject if any of these appear, anywhere, in any form:

`dive in`, `let's break it down`, `delve`, `delving`, `here's what
you need to know`, `it's worth noting`, `important to note`,
`it's important to remember`, `in today's market`, `in today's
volatile`, `navigating`, `landscape`, `unlock`, `unleash`,
`leverage` (as verb), `leveraging`, `robust`, `comprehensive`,
`game-changer`, `game changer`, `at the end of the day`, `circle back`,
`level up`, `moreover`, `furthermore`, `in conclusion`, `stay tuned`,
`exciting times`, `what are your thoughts`, `let me know in the comments`,
`drop your thoughts`, `🚀` (no rocket emoji ever — see also exception below),
`💎🙌` / `diamond hands`, `to the moon`, `fascinating`, `compelling story`,
`unpack`, `tell a story`, `the data tells`, `paints a picture`.

### 2. Throat-clearing opener
Reject if the first 5 words match any of: "Today's most", "Here are",
"Here's", "Looking at", "The top", "Welcome to", "Let's", "Did you know",
"Have you ever", "Are you", "Want to know".

### 3. No CTA / engagement bait
Reject if the post contains: "follow us", "click here", "DM us",
"share if you agree", "RT if", "tag a friend", "like + retweet",
"what do you think?".

### 4. Specificity
Reject if the post does NOT contain at least one of: a stock ticker,
a specific percentage, a specific dollar amount, a named person, a named
date or week, a sector name. Generic is failure.

### 5. Cashtag limit
Reject if the post contains more than one `$TICKER` (X 1-cashtag policy
returns 403 — see project memory). Lists of tickers must be plain.

### 6. Disclaimer presence (data-driven posts only)
Reject if the post surfaces ASIC short-position data and does NOT
acknowledge the source or delay somewhere in the chain (post text, OR
the destination URL is a `shorted.com.au` page where the disclaimer is
visible). For pure commentary posts (Shorted Take), this is a SOFT gate.

### 7. The destination URL
Reject if there's no canonical `shorted.com.au` URL on its own line
(so X parses it for the card preview) — unless the post is intentionally
URL-less commentary.

---

## SOFT gates (consider rewriting)

### 8. Sentence-length variance
For posts of 3+ sentences: at least one sentence < 8 words AND at least
one sentence > 18 words. If every sentence is 10-15 words you've written
a press release.

### 9. Hedge presence
Higher-heat posts (stock-of-day, Take, commentary): does the post hedge
where appropriate? "looks like / could be / hard to say / something to
watch" beats stating opinions as facts.

### 10. Cliché check (finance-specific)
Avoid: "rollercoaster", "wild ride", "bears vs bulls", "blood in the
streets", "smart money", "dumb money", "buying the dip", "catching a
falling knife" (unless used self-aware and ironic). One cliché might be
fine if it's load-bearing. Two means rewrite.

### 11. The read-aloud test
Read the draft out loud. Does it sound like something a real person
would say to a colleague over coffee? Or does it sound like a LinkedIn
post that tried to be conversational? If the second — rewrite.

### 12. The "did the bot write this" test
If you removed the data and just kept the framing/connectors, would the
post be indistinguishable from any other tweet about any other stock on
any other day? If yes — rewrite. The framing should be specific to the
content.

### 13. Variance from recent posts
Have we tweeted something structurally identical in the last 7 days?
Same opener, same line count, same kicker? If yes — vary it. Check the
recent timeline before posting.

### 14. Emoji discipline
Allowed sparingly: 📊 🔴 🟢 🏆 ⬇️ ↑ ↓ → ←. Use them for structure
(sentiment glyph, ranking marker, direction indicator), not decoration.
Never two emoji in a row. Never start a sentence with one.

### 15. Title case in the wild
Headlines/post bodies use sentence case, not Title Case (which reads as
press release). Only proper nouns and ticker codes capitalise.

---

## The "would I screenshot this" test

Before posting: imagine the post screenshotted and shared with a friend
who works in markets but doesn't read Shorted. Would they (a) keep
scrolling, (b) screenshot it back to send to someone, (c) reply with a
correction? The goal is (b). (a) means it was forgettable. (c) means
something's wrong with the data — go fix it.

---

## What to do when you fail a gate

1. Don't rewrite by adding more words. Usually the fix is removing
   words. The AI-ism phrase usually expanded a sentence that was crisper
   before it got added.
2. If you can't fix without losing meaning, ask whether the post needs
   to exist at all. A skipped post is better than a generic one. The
   bot's value compounds on quality, not frequency.
3. After 2 rewrites that still fail: post text-only with a shorter
   draft, or skip the slot. Don't ship slop.

---

## Worked example — fixing a failure

**Draft:**
> Today's most-shorted ASX stocks reveal a fascinating story. Lotus
> Resources continues to navigate the volatile rare earths landscape,
> with short interest at 16.01%. It's worth noting that this represents
> a key signal for investors. Let's dive in.

**Gates failed:**
- ❌ "Today's most-shorted" (gate 2, throat-clearing)
- ❌ "fascinating story" (gate 1, banned)
- ❌ "navigate", "landscape" (gate 1, banned)
- ❌ "it's worth noting" (gate 1, banned)
- ❌ "key signal" (gate 10, cliché)
- ❌ "let's dive in" (gate 1, banned)
- ❌ No URL (gate 7)
- ❌ No variance (gate 8 — every sentence is similar length)

**Rewrite:**
> LOT at 16.01% shorted. Same number it had a month ago.
>
> Rare earth shorts don't move much because nobody can be bothered
> covering them. It's a position you take and forget about.
>
> shorted.com.au/shorts/LOT

Different post. Same data. Sounds like someone.
