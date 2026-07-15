# Residential housing-crawl deploy (macOS, launchd)

Two residential Macs each crawl a disjoint suburb shard. No Docker, no Cloud Run —
the crawl only works from a residential IP driving the host's warm Chrome. See the
design/plan in `docs/superpowers/{specs,plans}/2026-07-13-realestate-*`.

## One-time per Mac

1. Build the collector for this Mac's arch:
   ```bash
   cd services && go build -o "$HOME/bin/house-price-collector" ./house-price-collector/
   ```
2. Install the Playwright driver the CDP client needs (this pulls chromium for the
   driver bootstrap; the crawl still renders on the *host* Chrome, not this one):
   ```bash
   cd services && go run github.com/playwright-community/playwright-go/cmd/playwright install chromium
   ```
3. (Optional first warm-up — the launcher now does this itself, see below.)
   Launch the DEDICATED-profile Chrome (NEVER the personal profile) with a **REA URL
   as its startup page**. Chrome's own (non-automated) startup navigation clears REA's
   Kasada challenge and sets a session cookie, so the crawl's Playwright REA fetches
   work. A Playwright-driven warm, or warming Domain, does NOT clear Kasada — REA then
   returns an ~870-byte KPSDK stub and the sweep is marked `blocked`. No manual clicking:
   ```bash
   /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
     --remote-debugging-port=9222 \
     --user-data-dir="$HOME/.shorted-housing-crawl-chrome" \
     "https://www.realestate.com.au/"
   ```
4. Create `~/.shorted-housing-crawl.env` (chmod 600, NOT committed):
   ```bash
   DATABASE_URL=postgresql://...            # prod Supabase (transaction pooler)
   CRAWL_CDP_URL=http://localhost:9222
   BRANDBRAIN_URL=https://api.brandbrain.dev
   # CRAWL_DRY_RUN defaults to false in the wrapper; set true to rehearse.
   ```
5. Install the launchd job:
   ```bash
   cd services/house-price-collector/deploy
   REPO="$(cd ../../.. && pwd)"   # repo root
   sed -e "s#__REPO__#$REPO#g" -e "s#__HOME__#$HOME#g" \
     com.shorted.housing-crawl.plist.template \
     > "$HOME/Library/LaunchAgents/com.shorted.housing-crawl.plist"
   # Set CRAWL_SHARD_INDEX to 1 on the SECOND Mac before loading.
   launchctl unload "$HOME/Library/LaunchAgents/com.shorted.housing-crawl.plist" 2>/dev/null
   launchctl load  "$HOME/Library/LaunchAgents/com.shorted.housing-crawl.plist"
   ```

## Rehearse before going live
```bash
CRAWL_DRY_RUN=true CRAWL_SHARD_INDEX=0 CRAWL_SHARD_COUNT=2 \
  bash run-housing-crawl.sh   # writes nothing; check ~/Library/Logs/shorted-housing-crawl.log
```

## Kick a real run now
```bash
launchctl start com.shorted.housing-crawl
```

Exit codes: `0` ok · `3` re-warm the Chrome profile (notification fired) · `4` Chrome not reachable (even after the launcher's own auto-launch attempt) · `5` REA warmcheck failed (could not clear Kasada, even after the launcher's auto re-warm retries).

## Reliability: the launcher is now self-healing

`run-housing-crawl.sh` no longer depends on an operator remembering to launch
Chrome with a REA startup URL by hand. Before every run it: (1) auto-launches
the dedicated Chrome if the CDP port isn't reachable, (2) runs the collector's
`-mode warmcheck` preflight to PROVE the REA session actually cleared Kasada
(a reachable CDP port is not the same thing as a warm REA session), relaunching
Chrome + re-checking up to twice if it's cold, and (3) only then runs the real
crawl. The manual launch command in step 3 above is still useful for a first
warm-up / manual rehearsal, but the scheduled launchd run does it itself.

## Queue mode (`-mode agent`) — auth via the co-located BrandBrain agent

The launcher above runs the STANDALONE path (`-mode listings` / `-mode crawl`,
each Mac crawling its own shard directly). To instead drain the shared
**brandbrain crawl-jobs queue** (`api.brandbrain.dev`) so multiple Macs fan
suburbs out via SKIP-LOCKED, run `-mode agent` / `-mode enqueue`.

**No token to mint or manage.** On any rig where the BrandBrain **macOS agent is
signed in**, the collector authenticates by re-reading the agent's *current*
access token from its loopback control API — and re-fetches a fresh one
automatically on a `401`. So an unattended batch never expires mid-run, and there
is no long-lived credential to mint, store, or rotate.

```bash
# ~/.shorted-housing-crawl.env
BRANDBRAIN_AGENT_URL=https://api.brandbrain.dev
CRAWL_AGENT_ID=housing-<host>          # optional; names this rig in the queue
CRAWL_AGENT_MAX_JOBS=8                  # safety cap per run
# BRANDBRAIN_AGENT_TOKEN is OPTIONAL — the collector reads the running agent's
# token from ~/.brandbrain/{diag-port,control_secret} and refreshes it on 401.
# Override the endpoint with BRANDBRAIN_CONTROL_PORT / BRANDBRAIN_CONTROL_SECRET.
```

Enqueue the suburb catalog once (`-mode enqueue`), then each rig runs `-mode
agent` (claim → warm-Chrome crawl → submit counts back). A suburb an agent
reports `failed` **auto-re-pends up to `max_attempts` (3) across warm runs** once
the brandbrain-side `Submit` re-pend fix lands (branch `fix/crawl-submit-repend`),
so a transient block no longer needs a manual re-enqueue.

Why this works: the agent's session access token has a **15-min TTL** (rotated
~every minute off a **30-day** refresh token). The old approach snapshotted it
once (`get-bb-token.sh`), so an unattended batch `401`'d after ~11–16 min and only
cleared ~3–6 suburbs. The collector now re-reads the always-fresh token from the
running agent on demand — the agent is the durable auth, no minting required.

**Fallback — a rig with no local BrandBrain agent** (e.g. a headless box): supply
a long-lived scoped token in `BRANDBRAIN_AGENT_TOKEN`. brandbrain natively
supports these (`api_tokens`); a token with **both** `agent:crawl` + `agent:upload`
scopes is a drop-in. Mint via `POST /api/v1/ml/auth/tokens`
(`{scopes:["agent:crawl","agent:upload"],expires_in_hours:8760}`, needs
`ML_TOKEN_MINT_SECRET` on the brandbrain env), or bridge with the 24h
`POST /api/v1/agent/refresh`.
