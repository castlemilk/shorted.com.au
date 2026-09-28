# What this server covers — and what it deliberately does not

Read this before concluding that a number is missing because of a bug. Several
of the gaps below are contractual, and no future version will fill them.

## Domains

**Market and stocks (ASIC, ASX).** Daily net short positions for every
ASX-listed security with reportable positions, back to 2010, plus company
metadata (name, sector, industry), historical prices, director and insider
trades from ASX Appendix 3Y filings, and derived views: industry treemaps,
squeeze candidates, a screener, per-stock news with classified sentiment, and
LLM-narrated weekly/monthly/yearly reports.

**Housing.** Official house-price series (ABS and RBA), state Valuer-General
transfer data where a state publishes it, and per-suburb profiles combining
prices with ABS Census, electoral and — where licensed — crime overlays. Also
derived price-drop aggregates.

**Economy.** A generic economic-series layer over ABS and RBA sources — CPI,
labour force, trade, state final demand, petroleum, government finance,
building approvals, retail, population — plus operations-weighted
company-to-state exposure aggregates.

**Strategy picks and fundamentals.** Five named stock-picking strategies
(Zanger Breakout, CAN SLIM, Minervini Trend Template, and two of Shorted's own:
Crowded-Short Breakout and Quality compounders) evaluated daily over end-of-day
prices, reported fundamentals and ASIC short interest, each stock getting a
pass, fail or unknown on every rule, plus the S&P/ASX 200 market regime. Picks
can be reordered by a fundamentals figure (`sort_by`: revenue or EPS growth,
return on equity, net or free-cash-flow margin, P/E lowest first, or market
cap); the rank stays the strategy's, and a stock without that figure sorts
last. Each pick names where its growth figures came from
(`fundamentals_source`: a parsed ASX filing, or the vendor).

The fundamentals are company statement figures per period (income statement,
balance sheet and cash flow: revenue, operating income, net income, EPS, cash
flow, capex, equity, net debt, shares) collected through market data providers
and from parsed ASX results filings, in each company's **reporting currency**,
which is not always AUD. A figure that was not reported is absent rather than
zero, and `field_sources` names any field that came from somewhere other than
the row's own source (a filing, a second provider, or a derivation such as
operating cash flow from free cash flow plus capex). Quarter rows are
balance-sheet snapshots only: ASX companies report income and cash flow
half-yearly. A filing figure is published only when it can be grounded in the
document, checked against the vendor's figures and dated to the document's own
period; otherwise it is withheld.

Quality ratios (margins, return on equity and assets, cash conversion, net debt
excluding leases, leverage, liquidity, payout) use one flow period and a
balance sheet aligned to it. Some are withheld on purpose, and the result says
which and why:

- For banks, insurers and other financials, margins below the top line, cash
  conversion, net debt, leverage, the current ratio and interest cover are not
  meaningful, and are listed in `not_meaningful` instead of reported. Return on
  equity, return on assets, net margin and payout remain.
- Market cap, P/E and P/B use the latest close. P/E and P/B are withheld when
  the statements are not in AUD, or when the vendor's figures were converted
  from another currency (`valuation_note: non-aud`), because an AUD price over a
  foreign-currency figure is not a ratio. All three are withheld when the
  listed unit is not one ordinary share, such as a CDI (`listed-unit`), and
  market cap and P/B need a recent share count we can vouch for (`no-shares`
  when there is none).
- For property trusts, profit and EBITDA include revaluations
  (`is_property`).

Fundamentals do not yet cover every stock, and our providers hold no statements
for some listed companies; `coverage` says whether a stock is covered, not yet
collected, empty at our providers or failed on its last attempt. None of those
means the company publishes no accounts. Where fundamentals are missing, the
growth and quality rules read unknown and those stocks cannot trigger. This is a
rules-based screen, not a recommendation.

**Politicians.** The federal Registers of Members' and Senators' Interests,
parsed into structured facts: which politician declared which asset class,
which listed company, which suburb, in which parliament.

## The exclusions that are not going away

**Individual property listings are never republished.** The site crawls
residential listings under terms that permit derived aggregates only, so this
server exposes suburb-level and market-level statistics and never a per-address
listing, agent, agency or photograph. Asking for "the listings in X" cannot be
satisfied; ask for the suburb's aggregates instead.

**The register of interests carries no amounts.** What a politician holds is a
public fact; how much of it they hold is not published in the source in a form
we republish, and there is **no amounts** column anywhere in this subsystem — no
value, no quantity, no parcel size. Any figure attached to a declared interest
would be invented.

**Parliamentary prose is verbatim or absent.** The Australian Parliament House
material is licensed **CC BY-NC-ND**. No-derivatives means a declared-interest
description is reproduced exactly as filed or not at all; do not paraphrase,
summarise or "clean up" one of these strings and present the result as the
declaration. Source PDFs are not served here — deep-link aph.gov.au instead.
Portraits, where present, come from Wikimedia Commons and carry a mandatory
attribution string that must travel with the image.

**Ambiguity resolves to silence.** Where a name, address or company could not
be resolved with confidence, the record is withheld rather than guessed. An
absent politician-to-company link means "not confidently resolved", not
"does not exist".

## Freshness

| Domain | Cadence | Lag |
|---|---|---|
| Short positions | daily | T+4 trading days |
| Prices, news, director trades | daily | same day to a few days |
| Strategy picks | daily, after the evening price sweep | end of day |
| Company fundamentals | nightly collection; companies file half-yearly | days to weeks after filing |
| Reports | weekly, monthly, yearly | published after period close |
| House prices, economic series | monthly or quarterly, per source | weeks to a quarter, set by ABS/RBA |
| Register of interests | per parliamentary update | days after publication |

## Attribution

ASIC and ABS/RBA material is reproduced under the source's own terms and is
attributed in tool output where the licence requires it. Keep that attribution
attached when quoting a figure onward — it is a licence obligation, not a
citation nicety.
