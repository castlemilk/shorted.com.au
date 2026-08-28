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
| Reports | weekly, monthly, yearly | published after period close |
| House prices, economic series | monthly or quarterly, per source | weeks to a quarter, set by ABS/RBA |
| Register of interests | per parliamentary update | days after publication |

## Attribution

ASIC and ABS/RBA material is reproduced under the source's own terms and is
attributed in tool output where the licence requires it. Keep that attribution
attached when quoting a figure onward — it is a licence obligation, not a
citation nicety.
