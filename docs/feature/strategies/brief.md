# Strategy workspace: product brief

The owner's brief (2026-11-04) for growing `/picks` into a strategy workspace. The six
PNGs in this folder are the concept mockups. They show sample data, not real figures.

| Mockup | View |
|---|---|
| `Strategy explorer_ historical returns heatmap.png` | Strategy explorer |
| `Crowded-Short Breakout backtest dashboard.png` | Strategy profile, Backtest tab |
| `Shorted strategy signal explorer.png`, `Shorted strategy signals dashboard mockup.png` | Strategy signals (two variants of the RS column) |
| `Create a strategy alert workspace.png` | Alert builder |
| `Strategy alert centre and signal evidence.png` | Alert centre |

## The intended flow

Explore strategies → inspect a strategy and its backtest → review qualifying stocks →
configure an alert → inspect subsequent signals.

## The five views

| View | Main workspace | What it lets the user do |
|---|---|---|
| Strategy explorer | Annual-return heatmap, strategy filters and a selected-strategy panel | Compare approaches, holding horizons and historical behaviour; select strategies for comparison or open a profile. |
| Strategy profile / Backtest | Equity curve against a benchmark, aligned drawdown chart and monthly-return heatmap | Investigate performance alongside the exact rules and assumptions behind it. |
| Strategy signals | Stock-by-rule matrix with a price, volume and evidence panel | Understand why a stock qualifies, what is still missing, and create an alert for that stock or the strategy. |
| Alert builder | Editable entry and exit conditions, with a preview of matching stocks | Configure the monitored universe, rule combinations, evaluation timing, notification behaviour and delivery. |
| Alert centre | Saved rules, event history and an explanation of the selected event | See which alerts are running, what triggered, which checks lacked data and whether notifications were delivered. |

## The strategy profile is the central page

This follows the fund-profile approach: each strategy gets its own identity, explanation and
investigation tools. Local navigation: **Overview · Rules · Backtest · Signals · Trades**.

The Backtest tab keeps the important evidence together:

- Strategy versus benchmark, over the same period.
- Drawdown directly beneath the equity curve, so losses remain visible alongside growth.
- Monthly returns, exposing stronger and weaker periods.
- Return, drawdown, Sharpe, trade count and win rate, with a clear run identity.
- Execution assumptions, including entry timing, exit rules, position sizing, brokerage and
  slippage.

TradingView's report structure is a useful reference for separating performance, trade analysis
and detailed trades while keeping the primary chart readable. Its testing documentation also
supports exposing costs and distinguishing development data from an untouched evaluation period
(the mockup's "holdout period").

A strategy without a completed run displays "Run required". Editing its rules creates a new
variant that needs its own backtest.

## Alerts around explicit events

The alert builder has two independently enabled sections:

- **Buy / entry**: notify when the selected entry conditions newly qualify. The example combines
  short-interest, breakout/volume and liquidity conditions.
- **Sell / exit long**: monitor explicitly tracked entries against exit conditions, such as
  falling below the captured entry pivot or reaching a holding-period limit. Tracking the entry
  supplies the reference price, pivot and elapsed time needed for those rules.

| Setting | Proposed behaviour |
|---|---|
| Scope | One stock, a watchlist or an eligible universe. |
| Condition groups | Combine criteria using ALL or ANY. |
| First evaluation | Record a baseline and wait for future transitions, or notify on existing matches. |
| Repeat behaviour | Notify once per event, then rearm after the condition resets; apply a configurable cooldown. |
| Missing data | Show an unavailable state and pause that stock's evaluation. |
| Delivery | Email and in-app notifications, with delivery status visible in the alert centre. |

"Is above" and "crosses above" differ: one describes a state, the other a transition. The
composer makes that choice explicit, alongside notification frequency.

The default cadence is after the daily data update, matching Shorted's existing end-of-day
strategy calculations.

## How this fits the current product

The current API already provides named strategies, ranked picks, screening status and per-rule
evidence. Those support the discovery and stock-investigation views. Portfolio backtests, formal
execution recipes, historical signal events and configurable strategy alerts are new capabilities.

For short-interest backtests, the data-coverage detail must explain publication timing and
revisions: Shorted exposes publication-availability dates, and historical ASIC revisions are
overwritten.

**The design rule to lock in: the strategy, the backtest and the alert all reference the same
version of the rules.** Opening "Create alert" from a backtest carries that version and universe
into the builder, so it is clear exactly what the user is choosing to monitor.

## Capability by membership (added 2026-11-04)

The owner wants the workspace staged by membership: **anonymous (free) → signed in (free
account) → paying (Premium)**. Each view should offer something real at every tier, and each step
up should unlock a clear, named capability (more depth, saving, alerting, running your own
variants), not a blurred page. The tier rules must be enforced by the API, not only hidden in the
UI, and the public, indexable pages must stay crawlable and useful to search visitors.

## Owner decisions (2026-11-04)

These override any design default that disagrees.

1. **URL root: `/strategies`**, with permanent redirects from every `/picks` URL, and a
   "Strategies" item in the top nav. The local sub-nav is Explore / My strategies / Signals / Alerts.
2. **Backtests: real runs, bias disclosed.** Crowded-Short Breakout and the Minervini Trend
   Template run from May 2019 (the start of the ASX 200 gross total-return index, XJT) against XJT,
   with price coverage by year and a survivorship warning that says which way the bias runs (it
   flatters results). Zanger, CAN SLIM and Quality Compounders show "Not computable before FY2023"
   or a short, labelled 2023+ run.
3. **Membership ladder:**
   - Anonymous: the explorer, strategy profiles, rules, backtest charts and the top 10 signals per
     strategy.
   - Signed-in free: adds the full signal list with evidence, compare, saved strategies and the
     trades list.
   - Premium: adds strategy alerts (entry and exit, tracked entries, email and in-app) and "Edit a
     copy" variants with their own backtests. Alerts stay Premium-only, as today's short-interest
     alerts are.
4. **Shipping:** each phase is pushed as its own PR once it passes Opus review. The owner merges.
   No agent merges a PR or applies prod DDL; each PR gives the exact apply steps.
