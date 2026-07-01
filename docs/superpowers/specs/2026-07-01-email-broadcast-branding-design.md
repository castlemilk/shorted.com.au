# Email broadcast branding: logo + compressed article images

**Date:** 2026-07-01
**Branch:** `feat/email-broadcast-branding` (worktree off `origin/main`)
**Status:** Approved design

## Problem

Three issues reported on the live Resend broadcast system (see auto-memory `email-system`):

1. **Only a weekly-report email was seen** — the news-digest broadcast never reached the inbox. Need to establish why (no draft? scheduler didn't run? no content?) and get a news digest sent.
2. **Broadcast emails have no Shorted logo** — the shared HTML shell (`RenderHTML`) renders only a text "Shorted" wordmark, no image.
3. **News emails need article header images + the logo, delivered as "super compressed/efficient" images** for fast rendering.

## Constraints & facts (verified)

- All three broadcast types (`weekly_report`, `monthly_report`, `news_digest`) share `broadcast.RenderHTML(title, bodyHTML, unsubURL)` in the sender — **a logo added there lands on all three automatically.**
- `news_articles.image_url` already exists (migration 000032) and is populated from RSS media / an og:image backfill job. The digest simply never `SELECT`s it.
- Next's image optimizer only allows a small `remotePatterns` allowlist, so `/_next/image` can't optimise arbitrary news-CDN images → a self-fetching proxy is required.
- Email clients strip SVG and unreliably render base64 data-URIs → images must be **hosted PNG/JPEG at an HTTPS URL**; layout must be **table-based** (no flexbox).
- Web app is Next.js 14.2 on Vercel (Node runtime for route handlers).

## Design

### 1. Email logo asset — `web/public/email/logo.png`
Hard-optimised PNG wordmark derived from the existing brand. ~2× retina, displayed ~28px tall, **target ≤5KB** (pngquant/oxipng). Stable URL `https://shorted.com.au/email/logo.png`. PNG (Gmail strips SVG). A `logo-mark.png` tile may also be added as the image-card fallback.

### 2. Logo in the branded shell — `services/shorts/internal/services/shorts/broadcast/template.go`
`RenderHTML` replaces the text-only wordmark with `<a href="{PUBLIC_SITE_URL}"><img src="{PUBLIC_SITE_URL}/email/logo.png" height="28" alt="Shorted" style="display:block;border:0"></a>`, keeping the orange accent bar. Absolute URL taken from `PUBLIC_SITE_URL` (already an env of the shorts service), defaulting to `https://shorted.com.au`. Applies to **all** broadcasts.

### 3. Image proxy — `web/src/app/api/email/img/route.ts` (Node runtime, `sharp`)
`GET /api/email/img?u=<encoded url>&w=<width>&s=<hmac>`:
- **HMAC verify** (`EMAIL_IMG_SECRET`) over the canonical `u|w` string → 403 if bad/absent. Prevents an open proxy / SSRF vector.
- **Defense-in-depth:** reject non-`http(s)`, reject private/link-local/loopback hosts, cap fetch size + timeout, require an image content-type.
- Fetch → `sharp().resize(w*2 wide, height cap, cover).jpeg({ quality: 70, mozjpeg: true })` → return `image/jpeg` with `Cache-Control: public, max-age=31536000, immutable` (Vercel CDN + Gmail's image proxy each cache it — a thumbnail is fetched+compressed once).
- On **any** error → `302` redirect to `/email/logo-mark.png` so a card never shows a broken image.
- `sharp` added as a direct dep (Next 14 already ships it); fall back to `@napi-rs/image` if Vercel packaging misbehaves.

### 4. Digest article cards — `services/news-aggregator/digest.go` `runDigest`
- `SELECT` adds `image_url`.
- Each news item → an email-safe `<table>` card: left cell = 120px thumbnail via the **signed proxy URL** `{PUBLIC_SITE_URL}/api/email/img?u=…&w=120&s=…`, right cell = headline link + source host. NULL `image_url` → text-only row (no broken tile).
- Go signs the proxy URL with `EMAIL_IMG_SECRET` (HMAC-SHA256 hex over the identical canonical string the Node verifier checks — a cross-language parity test guards this).
- Newsroom-takes section gets the same card treatment (image if the take has one, else text).
- Plaintext alternative (`RenderText` body) unchanged — links only.

### 5. Config / secrets
- New **`EMAIL_IMG_SECRET`** shared by the Go signer (news-aggregator) and the Node verifier (web). Prod: Secret Manager + Vercel env; terraform-gated exactly like `UNSUBSCRIBE_SECRET` (default-off bool so apply-before-secret is safe).
- `digest.go` reads `PUBLIC_SITE_URL` for absolute URLs (add to the news-aggregator env if absent).

### 6. Ship + test-send flow (outward-facing — check in before prod writes)
1. Build all artifacts.
2. **Local verify:** a render harness emits the exact email HTML; Playwright screenshots it (desktop + narrow) to confirm the look before anything ships.
3. Deploy web + shorts + news-aggregator (merge to main = prod CD) and set `EMAIL_IMG_SECRET` in prod so `/api/email/img` resolves. *(Check-in here.)*
4. Regenerate the current-week `news_digest` draft (delete the stale draft row, re-run `RUN_MODE=digest`) so it carries the new image cards.
5. **Test-send one email** to `ben.ebsworth@gmail.com` via `POST /api/admin/broadcasts/send?id=…&to=…` (list untouched, draft preserved).
6. User reviews in inbox → user blasts the list from `/admin/broadcasts`.

### Investigation (folded into ship)
Establish why only the weekly report was seen: is there a `news_digest` draft in prod `broadcasts`? Did the Fri `news-aggregator-digest` scheduler run? Was there news/editorial content in the window? Fix the root cause, not just the symptom.

## Testing
- **Go:** `template_test.go` (logo `<img>` present, absolute URL); digest test (card HTML for an item with/without image, signed URL shape); HMAC sign/verify parity test (Go signer ↔ expected hex).
- **Web:** image-proxy route test (rejects unsigned, resizes+recompresses, redirects to fallback on fetch error, blocks private hosts).

## Out of scope
- Redesigning the weekly/monthly report *body* content (only the shared shell + logo change there).
- Backfilling images for old drafts (only newly generated drafts get cards).
- Moving to Resend Broadcasts/Audiences (own-table model retained).
