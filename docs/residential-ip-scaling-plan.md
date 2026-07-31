# Residential-IP Scaling Plan — the housing crawl volume story

**Status:** DECISION-READY groundwork for the owner. Research + planning only — no code, no
live crawling, no prod changes were made producing this.
**Date:** 2026-07-22
**Author:** research pass (agent), for owner sign-off.
**Scope:** how shorted.com.au scales its Kasada (REA / property.com.au) + Akamai (Domain)
residential-property crawl beyond a single residential IP / single rig, now that the tier-2
catalog is 500 suburbs and a property.com.au per-address crawl is coming online.

> This document lays out options with cost / effort / risk and a recommendation. It does **not**
> pick for you — the spend + hardware + ToS-appetite calls are yours (see §7 Forks). Every dollar
> figure is a 2026 market estimate with its source; treat as order-of-magnitude, confirm live before
> committing.

---

## 0. TL;DR

- **The constraint is NOT purely per-IP.** The block that matters is **session/device-fingerprint +
  volume-through-one-egress**, cleared per-session by the warm-native-Chrome path. Measured evidence:
  one residential IP got flagged after ~14 *bursty* hits (June, unpaced); at today's *heavy* pacing a
  40-suburb batch (~400 page-loads) completes block-free. So the lever is **pace + distinct warm
  sessions**, not "buy more IPs."
- **Recommendation: Phase D then A. Defer B/C.** Right-size *demand* first (delta-only re-crawls +
  longer TTL + churn-priority + spread cadence) — that likely makes **1–2 well-paced rigs sufficient
  for steady-state** and costs ~$0. Add **Option A (2–3 idle Macs on distinct home/premises IPs)** for
  headroom and to absorb the property.com.au surge — the queue already shards via `SKIP LOCKED`, so this
  is near-zero-code. **Do not buy proxies (B) or build a mobile app (C) until demand math proves a rig
  fleet can't keep up AND a Kasada-through-proxy spike has passed.**
- **The real cost driver is property.com.au traversal**, not the 500-suburb listings refresh. Full
  ~8.5k-address traversal is ~2–3× the entire listings tier in page-loads. Scoping that down
  (address-seeded, stale-only, capped) is the single biggest demand lever — and it's a *product* call,
  not an infra one (§7).

---

## 1. The constraint, measured

### 1.1 What actually triggers a block (evidence, not intuition)

| Signal | What the evidence says | Measured or assumed? |
|---|---|---|
| **Per-IP volume** | One residential IP was flagged after **~14 bursty hits** on 2026-06-24 (unpaced early run); "even headed then returned stubs" until cooldown. IP recovers after a cooldown. | **Measured** (early, fast pacing) |
| **Session / device fingerprint** | The **user's phone on the SAME home network was NOT blocked while the Mac crawl was** (this was specifically the **Akamai/Domain** `errors.edgesuite.net` block). → the block is scoped to the crawling *device/session*, not the whole premises IP. | **Measured** (single striking observation) |
| **Navigation fingerprint (Kasada/REA)** | Kasada distrusts *how* a page was navigated to. A **Playwright-driven** nav → ~870B KPSDK stub (blocked); Chrome's **native startup nav** to a REA URL clears the proof-of-work and sets a session cookie; the *same* CDP fetch path then returns the full ~1.17MB page. `blocked=0` across many suburbs once warm. | **Measured + automated** (§6.5 of housing-architecture.md) |
| **Per-URL repeat** | Repeated hits to one exact URL (Bondi) flagged that URL's internal mismatch gate from prior volume. | **Measured**, minor |
| **Kasada vs Akamai difference** | **Domain (Akamai) works cold** with any client (1.7MB `__NEXT_DATA__`). **REA/property.com.au (Kasada) need the warm native-startup session.** They block **independently** (that's why the queue splits rea/domain into separate jobs + separate circuit breakers). Melbourne `domain` blocks repeatedly (dense-CBD Akamai). | **Measured** |

**Synthesis:** the ceiling is a **product of three things** — (a) volume through one egress IP in a
window, (b) how "human" the warm session looks over time, (c) per-portal anti-bot posture. The strongest
mitigation already shipped is the **warm-Chrome session** (fixes the navigation-fingerprint layer) +
**heavy jittered pacing** (20–45 s between suburbs, 8–20 s between pages) + **per-source circuit breakers**.
Adding *distinct warm sessions on distinct egress IPs* multiplies capacity; adding raw IPs behind the same
un-warmed client does **not** (a proxy alone doesn't clear Kasada — see §3).

### 1.2 Current headroom — how much can one rig sustain?

**Observed pacing (from code + memory):**
- Inter-suburb delay `CRAWL_MIN/MAX_DELAY_MS` = **20 000 / 45 000 ms** (avg ~32.5 s).
- Inter-page delay `CRAWL_LISTINGS_PAGE_MIN/MAX_MS` = **8 000 / 20 000 ms** (avg ~14 s).
- `CRAWL_LISTINGS_MAX_PAGES` = **5** (but on-target sizing stops small suburbs at 1–2 pages).
- `CRAWL_AGENT_MAX_JOBS` = **20 jobs / drain**; under the per-source **split** model a suburb = 2 jobs
  (rea + domain), so one drain ≈ **10 suburbs both-portals** (~35–45 min).
- **Observed throughput: ~4.25 min/suburb (both portals) ≈ ~14 suburbs/hr/rig** (task-supplied,
  consistent with the pacing above).

**Page-load budget:**
- ~5 REA + ~5 Domain pages/suburb ≈ **~10 page-loads/suburb** (fewer for small suburbs).
- At ~14 suburbs/hr → **~140 page-loads/hr/rig**.
- A Mac idle ~8–12 h/day → **~1 100–1 700 page-loads/day/rig** *if run continuously* — but see the cliff.

**Where's the cliff?** Not a single measured number. What we actually know:
- **Block-free proof point:** a **40-suburb `-mode agent` batch returned 40/40 clean** (~400 page-loads in
  one warm session), and the full 115-catalog / 158-suburb / 22 155-listing corpus was built this way.
- **Flag proof point:** ~**14 bursty (unpaced) hits** flagged one IP in June.
- So the safe operating envelope is bounded **below** by "≥400 paced page-loads per warm session run
  clean" and the danger zone is "bursty/unpaced." The exact per-day-per-IP ceiling at heavy pacing has
  **not been probed to failure** (and deliberately shouldn't be on prod — probing the cliff *is* the
  risk). **Assume, conservatively, one rig sustains ~1 full 500×2 refresh spread over ~2–3 days of paced
  runs without approaching the June flag threshold.**

**Full-refresh cost on ONE rig (measured math):**
- 500 suburbs × 2 portals = **1 000 jobs**. At ~14 suburbs/hr → **~35.7 rig-hours** for one complete
  tier-2 refresh (matches the task's ~35 rig-hours).
- That's ~3–4 h/day × ~9–12 days on one rig, or a few overnight batches. **Sustainable but slow, and it
  leaves no headroom for property.com.au.**

**The property.com.au multiplier (the real problem):**
- property.com.au is per-**address** (AVM + sales history), resolved by **suburb→street→profile
  traversal** (a constructed slug can't reach a profile; you need the internal `pid` from the street page).
- ~**8.5k known addresses** (`address_key` corpus) → roughly **~9 000–12 000 page-loads** even with
  per-street caching (suburb pages + street pages + one profile/address). property.com.au profile pages
  are single fetches (no pagination) but still need Kasada-warm + pacing → order **~70–95 rig-hours** for
  a full traversal pass on one rig — i.e. **~2–3× the entire 500-suburb listings tier.** Full traversal of
  the *whole* ~15M-property portal is out of the question on residential rigs; only an **address-seeded**
  subset is realistic (§7 fork).

**Bottom line:** one rig can *just* keep the 500-suburb listings tier fresh on a slow cadence. Add
property.com.au at any meaningful address volume and **one rig is decisively the bottleneck.** That's the
demand driving this decision.

---

## 2. Option A — more residential Macs (horizontal, real IPs)

**What it is:** run the existing `-mode agent` collector on **N residential Macs**, each on a **distinct
premises / distinct home IP**. The brandbrain `crawl_jobs` queue already shards work across pollers via
`SELECT … FOR UPDATE SKIP LOCKED`, so N rigs claiming from the one queue fan the 1 000 jobs out with **no
new coordination code**. Each rig self-warms its own dedicated Chrome (`crawl_chrome.go`, shipped C1) and
auto-refreshes its brandbrain token from the co-located macOS agent — **fully unattended**.

**What's needed to run N Macs:**
1. Each Mac: the brandbrain macOS agent signed in (already the distribution vehicle — v1.8.0 bundles the
   collector and schedules it via a Swift `Timer`), OR a launchd plist running `-mode agent`.
2. Each Mac on a **different physical premises/IP** (co-located rigs on one home IP = **NO benefit**, see
   risks). The owner's existing residential machines at different locations are the ideal fit.
3. `-mode enqueue` once to fill the queue; rigs drain it. Nothing else.

**Throughput math (full 500×2 = 1 000-job refresh, ~14 suburbs/hr/rig):**

| Rigs (distinct IPs) | Full listings refresh | + property.com.au (~8.5k addr) | Steady-state feel |
|---|---|---|---|
| 1 | ~35.7 h | +~70–95 h | bottlenecked |
| 2 | ~17.9 h | +~35–48 h | workable weekly |
| 3 | ~11.9 h | +~23–32 h | comfortable weekly + property |
| 5 | ~7.1 h | +~14–19 h | headroom to spare |

(Each rig still paced heavily and warm-sessioned independently, so N rigs = N independent warm sessions
on N IPs = **N× the safe envelope**, not just N× speed.)

**Cost:**
- **Reuse existing idle Macs: ~$0 capex.** Electricity ~10–30 W under this (mostly-sleeping, jittered)
  load → **~$2–6/mo/Mac** at AU power prices. This is the cheap path.
- **Buy new hardware (only if needed):** Mac mini M-series ~**AUD $999** each one-off; but a new mini in
  the *same house* as an existing rig adds **zero** crawl capacity (same IP) — you'd be buying the
  *premises*, not the box. So new hardware only helps if placed at a new location (friends/family/office).

**Effort: LOW.** The queue, sharding, self-warm, token auto-refresh, and Sparkle fleet-distribution are
all shipped. Remaining work is operational: get the agent onto 2–3 machines at distinct locations + one
enqueue. The only *missing* piece flagged in memory is a **fleet view** (telemetry is local-NDJSON-only
today) and a **launchd scheduler + freshness alarm** (board went 3 days stale unnoticed once) — nice-to-
have, not blocking.

**Risks:**
- **Co-located rigs share one egress IP → NO benefit** and *worse* (concentrates volume on one IP → faster
  flag). Distinct premises is mandatory. **This is the binding constraint on Option A, not money.**
- Each new premises is a new "is this machine reliably on / awake / warm" surface — the self-heal
  (warmcheck + circuit-break + auto-relaunch) covers most of it, but a fleet monitor is worth adding.
- Disk footgun: the crawler drives Chrome, which piles up macOS `code_sign_clone` copies (264 GB filled a
  rig's boot volume once — see cuttlefish-rig-disk-chrome-clones). Any new rig needs the clone-groom cron
  (cuttlefish#43) or it will eventually ENOSPC.
- Household bandwidth/latency + the operator's own browsing share the pipe (minor at this volume).

---

## 3. Option B — residential / mobile proxy rotation

**The HARD technical question first (this gates everything): can a proxied connection still clear
Kasada?** Short answer: **a proxy alone does NOT clear Kasada.** Kasada's pipeline is layered —
(1) TLS/HTTP2 fingerprint, (2) IP reputation, (3) JS proof-of-work challenge, (4) browser/JS environment
fingerprint, (5) behavioural trust score → `x-kpsdk-ct` token. A residential/mobile IP only improves
**layer 2**. Our warm-native-Chrome path is what beats layers 1/3/4/5. So the **only** viable proxy wiring
is: **keep the warm real-Chrome path and route *that* Chrome through the proxy** via Chrome's
`--proxy-server=` launch flag (add it in `crawl_chrome.go`'s `launchDedicatedChrome`, alongside the
existing `--remote-debugging-port` / `--user-data-dir`). A headless/stealth client behind a proxy has
already been **tried and rejected** (all cold clients get the KPSDK stub — housing-residential-crawl).

**Even wired correctly, proxies carry Kasada-specific hazards:**
- **Session-to-IP pinning is mandatory.** The Kasada proof-of-work cookie + Akamai session are set during
  the *native startup nav* — they're bound to the IP that warmed them. If the proxy rotates the IP
  mid-session, layer-2 reputation + the session cookie's origin diverge → instant block. You'd need
  **sticky sessions** (one IP held for a whole warm session), which is the *expensive, low-rotation* proxy
  mode — you lose the "rotate to dodge volume" benefit that's the reason to buy proxies.
- **Residential proxy IP quality is unknown/variable** — many pool IPs are already flagged; Kasada scores
  IP reputation, so a bad exit poisons a warm session. **Mobile (4G/5G) IPs carry higher carrier trust**
  and are "rarely blocked" (hundreds of users NAT'd behind one IP) — but cost far more.
- **AU-geo is required** (locale/timezone/Accept-Language must match the exit — Kasada checks signal
  consistency). AU residential/mobile pools exist but are a smaller, pricier slice.

**Providers + 2026 pricing (USD, confirm live before buying — pages are inconsistent):**

| Provider | Residential $/GB | Mobile | Model | AU geo |
|---|---|---|---|---|
| **IPRoyal** | ~$7/GB (1 GB) → **~$1.75–$2.45/GB** at TB scale; **traffic never expires** | — | PAYG, non-expiring (great for bursty quarterly refreshes) | yes (country-level) |
| **Decodo** (ex-Smartproxy) | $3.75/GB (3 GB) → **$2.00/GB** (1 TB); PAYG ~$4/GB | via unified credits | monthly step-down + PAYG | yes |
| **SOAX** | $3.60/GB (25 GB) → ~$2.46/GB; unified credit pool | mobile 33M+ pool | monthly credits | yes, city-level |
| **Oxylabs** | ~$8/GB PAYG (~$4 promo) → **$2.50/GB** (1 TB) | **$9/GB** PAYG | premium; committed tiers | yes |
| **Bright Data** | ~$4–8.40/GB PAYG → ~$2.50/GB enterprise (+20–40% for city/ZIP targeting) | pricier per GB | premium; per-GB | yes, granular |
| **Dedicated AU 4G mobile** (Coronium / ProxyEmpire) | — | **~$80–145/mo per port, unlimited traffic** | per-port monthly, sticky | **native Telstra/Optus IPs** |

**Cost in *our* terms (bandwidth, not IPs):** proxies bill per GB, and a *real warm browser loads the
whole rendered page through the proxy* (HTML + JSON + images + JS), so bandwidth is much higher than the
~1.2–1.7 MB document size unless we block images:
- Listings full refresh: 500 × 2 × ~5 pages. At ~5 MB/fully-rendered-page → **~25 GB/refresh**; with
  Chrome image-blocking (`--blink-settings=imagesEnabled=false`) → **~7.5 GB/refresh**.
- property.com.au ~8.5k addresses traversal → **~15–30 GB** more.
- So a full "everything" pass ≈ **~20–55 GB**. At $2.50–8/GB residential = **~$50–440 per full pass**;
  **weekly cadence → ~$200–1 800/mo.** Mobile per-GB would be multiples of that. **Dedicated AU 4G ports**
  (unlimited traffic) sidestep per-GB entirely: **~$80–145/mo/port**, but each port is one sticky IP ≈ one
  extra "rig-equivalent" of warm-session capacity — so 3 ports (~$240–435/mo) ≈ the throughput of Option
  A's 3 idle Macs but at recurring cost and with the Kasada-through-proxy wiring risk.

**Effort: MEDIUM-HIGH.** Add `--proxy-server` plumbing + sticky-session handling to `crawl_chrome.go`;
**prove Kasada-through-proxy on a spike before spending** (this is the make-or-break — it has never been
tested); handle proxy-auth, per-session IP pinning, and per-exit warm re-tries.

**Risk: HIGH + a ToS/legal escalation.**
- Feasibility is **unproven** — Kasada is "the only vendor where DIY isn't viable in production" per 2026
  bypass write-ups; proxy IP quality varies; a rotating pool actively fights the warm-session model.
- **ToS/legal:** REA/Domain/property.com.au ToS prohibit automated access; **property.com.au robots.txt
  explicitly names shorted's exact use case** ("websites that … aggregate property listings/information").
  Buying commercial proxy infrastructure to systematically evade a bot-wall is a **materially different
  posture** from an operator paced-crawling from their own home connection — it reads as intent-to-
  circumvent (the codebase deliberately avoids adaptive threshold-learning pacers for the same reason,
  citing Criminal Code s477.1). This is a **judgment call for the owner**, not a technical default.

---

## 4. Option C — mobile / cellular agents (iOS / Android)

**What it is:** a React-Native / native app mirroring the brandbrain macOS agent, distributing crawl jobs
across phones on cellular IPs (the idea in property-listings-price-tracking UPDATE-3 and realestate-
subcrawler-distribution).

**Honest feasibility — flagged the WEAKEST egress, and the evidence backs that:**
- **Can a mobile WebView clear Kasada on native nav + expose the data blob?** *Unknown and doubtful.*
  A `WKWebView` (iOS) can't inherit Safari's warm Kasada jar, so it must **solve the proof-of-work fresh
  every session** — which is the canonical bot signature. No confirmation the ArgonautExchange blob is
  reachable from a mobile WebView's JS context.
- **No IP rotation control:** no public airplane-mode/radio-cycle API on iOS to force a new cellular IP.
- **No unattended loop:** iOS suspends background apps ~30 s — you can't run a multi-hour drain.
- **Distribution:** App-Store review would likely reject a scraper; operator's-own-device only; metered
  cellular data + potential carrier-ToS issues.

**Cost:** app build effort (weeks) + per-device; **but the gating cost is a Phase-0 spike, not the app.**

**Effort: HIGH. Risk: HIGH / mostly unknown.**

**Verdict: NOT a near-term lever. Spike-before-build.** If ever pursued, gate ALL work on a
**cellular WKWebView Phase-0 spike**: measure block/poison rate with & without warming, and confirm the
data blob is extractable, *before* writing a line of app code. Mobile's one genuine upside (high carrier-
trust IPs) is better captured, if needed, via **dedicated AU 4G proxy ports** (Option B) routed through
the *proven* warm-desktop-Chrome path than via an unproven mobile browser.

---

## 5. Option D — reduce demand instead of adding supply

The cheapest capacity is the work you don't do. Several demand levers likely make **1–2 well-paced rigs
sufficient for steady-state**, deferring the whole scaling spend:

1. **Delta-only / stale-only re-crawls.** The value is *price changes over time*, not re-confirming
   unchanged listings. Only 62.5% of active listings even carry a numeric price, and the drops board rests
   on ~243 price-drop events / 25 MV rows. A **"crawl suburbs/addresses not swept in N days OR flagged
   high-churn"** selector (the `CRAWL_LISTINGS_RESUME_WINDOW_H` checkpoint mechanism already exists,
   default off) collapses a full 1 000-job refresh to a **fraction** each run.
2. **Longer TTL / slower cadence.** Property asking-prices move on a weeks-to-months timescale, not daily.
   A **weekly or fortnightly** full refresh (vs the implicit "as fast as possible") is plenty for a
   price-drops board and stays well under the flag threshold. The crawl-aligned caching (`/price-drops`
   static ISR 1 h + KV 24 h, collector `pingRevalidate`) already assumes a slow, batch cadence.
3. **Churn-priority queue.** Enqueue high-turnover metro suburbs more often than sleepy ones (job
   `priority` field already exists in `crawlEnqueueInput`). Spend the rig-hours where drops actually happen.
4. **Spread the refresh over the week.** Instead of one 35-hour burst, run ~5 rig-hours/night — smaller
   warm sessions, lower per-window volume per IP, better evasion, same weekly coverage.
5. **Scope property.com.au tightly** (the big one — see §7): address-seeded (only the ~8.5k known
   `address_key`s, or a churn-filtered subset) + long TTL (AVM/sales-history barely change) instead of
   open traversal. This alone can cut the property.com.au demand by an order of magnitude.

**Quantified: at what cadence does 1 rig suffice?**
- One rig sustains ~35.7 rig-hours of full listings refresh. At ~4 h/night that's a full refresh every
  ~9 nights — **a fortnightly full refresh fits comfortably on ONE rig** with headroom.
- Switch to **delta-only** (say ~20–30% of listings change price in a fortnight → ~200–300 jobs) and one
  rig does a delta pass in **~7–11 h** → **a nightly delta + fortnightly full sweep fits on ONE rig.**
- Add property.com.au **address-seeded + monthly TTL** (AVM changes slowly): ~8.5k addresses / month ≈
  ~2–3 rig-hours/night → **still fits on 1–2 rigs.**

**So Option D + 1–2 rigs plausibly covers steady-state with ~$0 recurring spend.** The scaling question
only becomes urgent if the owner wants *fast full refreshes* or *broad property.com.au traversal*.

**Effort: LOW-MEDIUM** (mostly config + a stale-selector query; the resume/checkpoint + priority
mechanisms already exist). **Risk: LOW** (strictly reduces load + block exposure). **Cost: ~$0.**

---

## 6. Recommendation + phased path

**Recommendation: do D now, add A opportunistically, hold B/C.** Right-size demand before buying supply;
use the free horizontal path (idle Macs on distinct IPs) for headroom; treat proxies/mobile as a
last-resort that must clear a feasibility + ToS bar first.

### Phase 1 — Right-size demand (Option D) — **do first, ~$0, low risk**
- Turn on **delta/stale-only selection** (`CRAWL_LISTINGS_RESUME_WINDOW_H` + a "not swept in N days /
  high-churn" enqueue filter).
- Set an explicit **fortnightly full + nightly delta** cadence; spread over nights.
- Use the job **`priority`** field to favour high-churn metro suburbs.
- Add a **freshness alarm** (board went stale 3 days unnoticed once) + a minimal **fleet view** so you can
  see coverage without a full monitor.
- **Scope property.com.au to address-seeded + long TTL** (decision in §7).
- **Spend incurred: $0.** Outcome: measure whether 1–2 rigs now suffice. Likely yes for steady-state.

### Phase 2 — Horizontal headroom (Option A) — **do if Phase 1 isn't enough, ~$0 capex**
- Bring **2–3 existing idle Macs online at DISTINCT premises** (home + a second location). Sign in the
  brandbrain agent (v1.8.0 already bundles + schedules the collector) or install the launchd plist.
- Ensure each rig has the **clone-groom cron** (cuttlefish#43) to avoid the boot-disk ENOSPC footgun.
- **Spend incurred: ~$2–6/mo/Mac electricity** (reused hardware). New hardware only if a *new premises* is
  available (~AUD $999/mini one-off) — a second box in the same house buys nothing.
- Outcome: 2–3 rigs comfortably cover 500 suburbs weekly **plus** address-seeded property.com.au.

### Phase 3 — Proxies (Option B) — **ONLY if volume demands it AND a spike proves Kasada-through-proxy**
- **Gate:** first a **spike** — wire `--proxy-server` + sticky-session into `crawl_chrome.go`, buy the
  smallest PAYG residential block (IPRoyal non-expiring ~$7 for a couple GB, or one dedicated AU 4G port
  ~$80–145/mo for a month), and **prove a warm Chrome routed through it clears Kasada on REA +
  property.com.au** across a real batch. If it doesn't clear (likely hard), **stop — don't scale it.**
- Only if proven: prefer **dedicated AU 4G ports** (unlimited traffic, high carrier trust, sticky) over
  per-GB residential — ~$80–145/mo/port, budget by "ports = extra warm-session lanes."
- **Also an owner ToS/legal call (§7)** before any spend — buying evasion infra is a posture change.
- **Spend incurred:** spike ~$80–150 one month; ongoing ~$240–435/mo for 3 AU 4G ports, OR ~$200–1 800/mo
  per-GB residential at weekly cadence (image-blocking + delta-only pushes this toward the low end).

### Phase 4 — Mobile agents (Option C) — **parked; spike-before-build only**
- Only revisit if A+B are exhausted. **Gate on a cellular WKWebView Phase-0 spike** (can it clear Kasada +
  expose the blob?). Do not build the app before that passes. Likely never worth it vs AU 4G proxy ports.

---

## 7. Genuine forks for the owner (the calls only you can make)

1. **Budget ceiling for crawl egress.** Is the answer "$0 recurring — reuse machines + slow the cadence"
   (→ D + A), or is there appetite for **~$240–435/mo (3 AU 4G ports)** / **~$200+/mo (per-GB residential)**
   to get *fast* full refreshes? This picks whether Phase 3 is even on the table.
2. **How many DISTINCT-PREMISES Macs can you actually get?** Option A's throughput is capped by *distinct
   IPs*, not boxes. 1 home + 1 office + 1 family member = 3 lanes for free. Co-located boxes add nothing.
   **How many separate locations can host a quietly-running Mac?**
3. **Appetite for proxy spend AND its ToS posture.** Two linked calls: (a) will you *pay* for proxies, and
   (b) are you comfortable that buying commercial evasion infrastructure — against portals whose ToS
   (property.com.au's robots.txt *by name*) forbid this — is a posture you want to adopt? The current
   crawl leans on "operator paced-crawling from their own home." Proxies change that story.
4. **Is property.com.au FULL traversal even in scope?** This is the biggest demand lever and it's a
   *product* decision:
   - **Address-seeded only** (~8.5k known addresses, resolve pid via street page, long TTL) — fits on
     1–2 rigs, modest demand. **Recommended default.**
   - **Broad/new-address traversal** (walk suburb→street→every property) — ~15M properties, categorically
     infeasible on residential rigs and the strongest ToS-escalation vector. **Not recommended.**
   Which one? The answer changes the entire scaling calculus (address-seeded → you may never need Phase 3).
5. **Acceptable freshness SLA.** "Prices at most N days stale" sets the cadence, which sets the rig count.
   A fortnightly board fits 1 rig; a daily board needs the fleet. **What staleness is acceptable for the
   drops board / AVM layer?**
6. **Probe-the-cliff appetite.** We've never probed the per-IP-per-day block ceiling at heavy pacing (doing
   so risks flagging the home IP). Happy to keep operating conservatively below the known-safe envelope, or
   do you want a *controlled* headroom probe (accepting a possible cooldown) to learn the real number?

---

## Appendix — key facts this rests on (with pointers)

- Warm-Chrome mechanism + exit codes + queue: `docs/housing-architecture.md` §6 (esp. §6.5).
- Crawl code: `services/house-price-collector/crawl_agent.go` (queue drain, `maxJobs=20`, split rea/domain,
  circuit breaker), `crawl_cdp.go` (CDP fetcher, warm `Contexts()[0]`), `crawl_chrome.go` (self-warm /
  `launchDedicatedChrome` — where `--proxy-server` would go), `crawl_listings.go` (pacing knobs, on-target
  sizing), `crawl_targets.go` (115-suburb catalog today).
- Constraint evidence (phone-not-blocked, ~14-hit flag, warm-session, split-portal blocking): memory
  `property-listings-price-tracking`, `housing-residential-crawl`, `realestate-subcrawler-distribution`.
- property.com.au recon (same Kasada tenant, traversal-resolve, ToS-by-name): memory
  `property-com-au-crawler`.
- Disk footgun for new rigs: memory `cuttlefish-rig-disk-chrome-clones` (cuttlefish#43 groom).
- Proxy pricing (2026): IPRoyal / Decodo / SOAX / Oxylabs / Bright Data / AU 4G — see §3 table; Kasada
  layered-detection reality from 2026 bypass write-ups (ZenRows, Scrapfly, Scrapebadger).
```

