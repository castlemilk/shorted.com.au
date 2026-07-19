# Bundle the housing crawl into the brandbrain macOS agent

**Date:** 2026-07-19
**Status:** Approved design — ready for implementation plan
**Repos touched:** `shorted` (collector) + `brandbrain` (agent app, build, UI)

## Problem

The residential housing crawl runs today as a **loose collection of external artifacts** on the operator's Mac:

- the shorted `house-price-collector -mode agent` binary (the actual crawler),
- a launchd plist (`com.shorted.housing-agent`) for scheduling,
- an env file `~/.shorted-housing-crawl.env` holding shorted's **prod DB URL**,
- a shell wrapper `run-housing-agent.sh` that warms/recovers the dedicated Chrome before each run.

This is fragile (crawls triggered from a chat session get killed; the plist + env-file setup keeps tripping the "standing automation with stored prod creds" guardrail) and hard to operate. The goal: **fold all of it into the brandbrain macOS agent** — the app already runs persistently, supervises a subprocess, stores secrets in the Keychain, and has a Real-estate panel — so there are **no external scripts, plist, or env files**.

## Key constraint (why the shape is what it is)

- The crawl writes `property_listings` to **shorted's prod DB** and submits **counts-only** back to brandbrain. brandbrain must stay counts-only — no listing rows/addresses/PII in brandbrain.
- REA is behind **Kasada**, which is only cleared by a **persistent dedicated Chrome warmed via a native REA startup-nav on a CDP port**. brandbrain's Go runtime drives Chromium via **Playwright, ephemeral + headless, launched-and-closed per crawl** (`backend/internal/discovery/crawler_playwright.go:220-230`) — that mode does **not** clear Kasada, and there is no persistent-Chrome/CDP infra in brandbrain to reuse (repo-wide: no `ConnectOverCDP`, no `--remote-debugging-port`, no `--user-data-dir`).

Therefore the warmed Chrome + REA/Domain extraction + shorted-DB write are **irreducibly the collector's job**. Bundling means the agent **orchestrates** the collector, not **reimplements** it.

## Decisions (accepted)

1. **Execution model:** the agent **spawns the bundled collector binary** (`-mode agent`) as a subprocess — mirroring how the Swift app already spawns `brandbrain-agent-runtime`. Not a port of the crawl into brandbrain's Go binary (that would duplicate a large amount of code and drag shorted's prod-DB access + listing data into brandbrain).
2. **Binary provenance:** the collector is **built into the DMG cross-repo** — brandbrain's `build-dmg.sh` builds the shorted collector and copies it into `Contents/Resources/`, auto-signed + notarized. Fully self-contained app. **Accepted tradeoff:** a collector change now requires a new brandbrain agent release to ship.
3. **Secret storage:** shorted's prod DB URL lives in the **macOS Keychain** (entered once in the Real-estate tab), never on disk in plaintext, never sent over the loopback control API — injected only as the collector child process's `DATABASE_URL` env.
4. **Chrome warming:** moves **into the collector binary** (Go port of the shell wrapper), so `collector -mode agent` is fully self-sufficient.
5. **Scheduler:** a Swift `Timer` in the app (owns UI, Keychain, cadence). Default cadence **twice-daily** (bot-safe).

## Architecture

```
┌─ brandbrain macOS agent (SwiftUI app) ──────────────────────────┐
│  Real-estate tab: [Auto-crawl ▸ on/off · cadence · Run now]     │
│  HousingCrawlSupervisor (Swift Process, mirrors                 │
│    AgentRuntimeSupervisor) ── spawns ──┐                        │
│  KeychainVault  ── DATABASE_URL ───────┤ (injected as child env)│
└────────────────────────────────────────┼───────────────────────┘
                                          ▼
        Contents/Resources/housing-crawl-collector   (shorted binary)
          -mode agent → self-warms dedicated Chrome → crawls REA/Domain
          → writes property_listings to SHORTED prod DB
          → submits counts-only to brandbrain queue (own auto-refresh token)

  brandbrain-agent-runtime (unchanged) — already polls the brandbrain queue
    every 20s → the Real-estate panel's progress bar renders for free.
```

The Go runtime (`brandbrain-agent-runtime`) is **not** in the spawn path. Its existing `startCrawlJobsPoll` (`backend/cmd/agent/main.go:478`, 20s, `GET /api/v1/agent/crawl-jobs`) already feeds `crawl_jobs` into `/control/v1/status`, which the panel polls every 5s — so live progress is already wired.

## Components

### C1 — shorted collector self-warms Chrome (retires the shell wrapper)

New `services/house-price-collector/crawl_chrome.go`, porting `deploy/run-housing-agent.sh`:

- `warmChrome(cfg)` — launch dedicated Chrome: `--remote-debugging-port=<port>`, `--user-data-dir=<profile>`, startup URL `https://www.realestate.com.au/` (native nav clears Kasada); `disown`; sleep ~12–15s.
- `chromeReachable(cdpURL)` — `GET <cdp>/json/version`.
- `recoverWedgedChrome(cfg)` — the "CDP answers but can't hand out a context" case: **SIGKILL dedicated-profile Chrome only** (fixed-string match on `--user-data-dir=<profile>` over `ps -axww`, never a regex, never the personal profile), confirm gone, clear `SingletonLock`/`SingletonCookie`/`SingletonSocket`, relaunch.
- Auto-warm preflight in `-mode agent`: if `!chromeReachable` OR warmcheck fails OR wedged → warm/recover, then crawl. Existing `-mode warmcheck` is reused as the warmth probe.

Config via env with the same defaults as the script: `HOUSING_CRAWL_CHROME_BIN` (default `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`), `HOUSING_CRAWL_CHROME_PROFILE` (default `~/.shorted-housing-crawl-chrome`), `CRAWL_CDP_URL` (port derived). A `CRAWL_AUTO_WARM` toggle (default **on** for macOS) lets the headless/server path opt out.

**Safety guard (load-bearing):** the profile dir always has a non-empty value defaulted from `$HOME`, and the kill matches the **exact** `--user-data-dir=<profile>` string — the personal Chrome never carries that flag, so it can never be matched. This must have a unit test.

Result: `collector -mode agent` is self-sufficient. `run-housing-agent.sh` stays valid for headless/server use but is no longer required on the Mac.

### C2 — cross-repo bundling in brandbrain `build-dmg.sh`

New step `[2b/6]` immediately after the Go-runtime build (`scripts/build-dmg.sh:166-199`) and **before** the bottom-up codesign (`:374-387`):

- `CGO_ENABLED=0 go build` the collector from `$SHORTED_REPO/services/house-price-collector` → `Contents/Resources/housing-crawl-collector`, universal via `lipo` (same pattern as the runtime).
- `SHORTED_REPO` env, default `~/projects/shorted`. **Required** for a release that ships the feature — hard error with a clear message if the path is missing (don't silently ship a broken feature).
- Record the collector's `git -C "$SHORTED_REPO" describe --tags --always` into the bundle (e.g. `Contents/Resources/housing-crawl-collector.version`) for the panel's debug line.
- Because it's added before signing, the existing bottom-up codesign + notarize/staple covers it automatically.

### C3 — Swift `HousingCrawlSupervisor` + secret

New Swift type mirroring `Services/RuntimeSupervisor.swift`:

- Resolves `Bundle.main.resourceURL/housing-crawl-collector`; spawns `-mode agent` via `Foundation.Process`.
- Injects env: `DATABASE_URL` (Keychain), `BRANDBRAIN_AGENT_URL`, `CRAWL_CDP_URL`, `CRAWL_DRY_RUN=false`, `CRAWL_AGENT_MAX_JOBS`, `CRAWL_TIMEOUT_MIN`.
- Captures stdout/stderr to `~/.brandbrain/housing-crawl.log`; parses the terminal `job … → succeeded/blocked` lines into a last-run summary struct.
- **One run at a time** (supervisor guard). Each run is a bounded batch (collector's existing job/time caps). The cadence `Timer` skips a tick if a run is in flight.
- The collector claims jobs with **its own** brandbrain token flow (auto-refresh from `~/.brandbrain/{diag-port,control_secret}`), so no token plumbing is needed from the app.

**Secret:** stored via `KeychainVault` (`Services/KeychainVault.swift`, service `com.brandbrain.agent`) under a new account e.g. `housing:shorted_database_url`. Read at spawn time only — **not** written to `config.yaml`, **not** POSTed to the control API. This is intentionally cleaner than the Gemini-key pattern (`State/CrawlStore.swift:158` → `POST /control/v1/config` → plaintext `config.yaml`), because a prod DB URL warrants Keychain.

### C4 — Real-estate tab UI + cadence

Extend `Views/RealEstateView.swift` (currently strictly read-only) with an "Auto-crawl" card above the existing queue view:

- **DB-URL `SecureField`** → Keychain; shows "configured ✓" once set, with a "Replace" affordance.
- **on/off toggle** + **cadence picker** (Off / every 3h / every 6h / twice-daily; default twice-daily). State persists in `UserDefaults`.
- **Run now** + **Stop** buttons call the Swift `HousingCrawlSupervisor` **directly, in-process** (start/terminate the child). This is simpler than the Brands-tab precedent (`ControlAPIClient.startCrawl` → `POST /control/v1/crawl/start` → Go runtime), which is cited only to show the button→action UI pattern already exists — the housing path does **not** round-trip through the Go runtime or the loopback control API, keeping the DB secret entirely inside the Swift process.
- **Last-run summary**: jobs · events · blocked · a "will re-warm next run" note when the collector circuit-breaks (exit 3). The existing progress bar + state-coverage view keep rendering from the queue poll.

### C5 — Validation & observability (a solid footing to validate + improve the crawl)

The point of bundling isn't just "it runs unattended" — it's a **tight feedback loop for iterating on crawl quality** (e.g. the recurring Unley-REA poison SRP we watched block every warm cycle). Beyond the aggregate panel (success % / blocked / stalled), add:

- **Per-run, per-suburb, per-source outcome capture.** The collector already logs each job (`suburb/source → succeeded|failed: listings=N events=M blocked=B`). C3's supervisor parses these into a structured last-run report and appends to `~/.brandbrain/housing-crawl-runs.jsonl` (last N runs). The tab shows a compact per-run breakdown so poison SRPs are **visible + named**, not buried in a log.
- **Block/poison surfacing.** The tab's blocked list names the **suburb + source** that blocked, so a recurring poison (Unley-REA) can be investigated or excluded — the core "improve" loop. (Ties into the open brandbrain re-pend follow-up, PR #168.)
- **Validate (dry-run) affordance.** A **"Test run (no writes)"** button spawns the collector with `CRAWL_DRY_RUN=true` (already supported) — exercises the full warm→claim→crawl→extract path against live REA/Domain **without** writing `property_listings`, so the operator can confirm health after a code/config change before a real run.
- **Targeted deep-debug pointer.** `CRAWL_TRACE` (per-page screenshots + `trace.jsonl`, local-only/gitignored) stays the single-suburb debug tool; the tab documents how to run it rather than embedding it.

Scope guard (YAGNI): **no** time-series DB, **no** dashboards — just structured last-N-runs capture + the dry-run validate button + the named block list. Enough to validate a run and see what to fix next.

## Data & control flow

1. Operator enters shorted DB URL once → Keychain.
2. `Timer` fires (or Run now) → supervisor checks "not already running" → reads DB URL from Keychain → spawns `housing-crawl-collector -mode agent` with env.
3. Collector auto-warms the dedicated Chrome (C1), claims jobs from brandbrain (own token), crawls REA/Domain, writes `property_listings` to shorted prod DB, submits counts to brandbrain.
4. `brandbrain-agent-runtime` keeps polling the queue every 20s → panel shows live progress the whole time.
5. Collector exits (batch/time cap) → supervisor records the summary → next tick re-runs on cadence.

## Error handling

- **Chrome wedged / Kasada expired mid-run:** collector circuit-breaks after 2 consecutive blocked jobs (exit 3); because it now self-warms, the *next* scheduled run recovers. Panel surfaces "blocked — will re-warm next run."
- **Missing DB URL:** UI blocks enabling auto-crawl / Run now until configured.
- **Collector binary missing from bundle** (dev builds): supervisor disables the card with a clear "housing crawl not bundled in this build" message.
- **Overlapping runs:** prevented by the single-run supervisor guard.
- **Token expiry:** already self-healing in the collector (auto-refresh from local agent control creds).

## Testing

- **shorted (Go):** unit-test the dedicated-profile pid match (must never match a personal-profile Chrome command line), the wedged-detection predicate, and the auto-warm decision (`chromeReachable`/warmcheck → warm-or-not). Browser launch itself stays a local/manual integration check (`-mode agent` against a cold CDP port).
- **brandbrain (Swift):** cadence-logic tests (tick skipped while running; Off disables), Keychain round-trip, and env-injection via a **stub binary that echoes its env** (assert `DATABASE_URL`/caps present, secret absent from any file). Build check: after `build-dmg.sh`, assert `Contents/Resources/housing-crawl-collector` exists, is executable, and is signed.
- **C5 (validation):** parse a sample collector log into the structured per-suburb/per-source run report (assert blocked suburb+source is named); assert a dry-run "Test run" spawns with `CRAWL_DRY_RUN=true` and the run-report round-trips to `housing-crawl-runs.jsonl`.
- **E2E (local):** `make agent-ui-install` → enter DB URL → Run now → confirm a real crawl advances the brandbrain queue and the panel surfaces the summary.

## Retirement

On the Mac, the bundled agent **supersedes**: the launchd plist `com.shorted.housing-agent`, `~/.shorted-housing-crawl.env`, and `run-housing-agent.sh` as the *required* path. The shell script + collector modes stay valid for headless/server/CI use (they benefit from C1's self-warm too).

## Prerequisites & sequencing

- **Panel branch first:** `RealEstateView.swift` + `crawl_jobs_view.go` currently live in the brandbrain `canvas-asset-sets` worktree, not `main`. That panel work must be merged/rebased onto `main` before C3/C4 land on top.
- Suggested order: **C1** (shorted, independently shippable + testable) → **C2** (brandbrain build) → **C3** (supervisor + Keychain, incl. the C5 run-report capture) → **C4** (UI, incl. the C5 per-run breakdown + dry-run "Test run" button) → E2E. C5 is not a separate phase — its capture lands in C3 and its surfacing in C4.

## Out of scope (YAGNI)

- No in-app collector auto-update (the accepted decision is DMG-bundled; updates ride the brandbrain release).
- No multi-machine coordination changes (the existing distributed-agent design is untouched).
- No change to the brandbrain queue schema or the counts-only contract.
