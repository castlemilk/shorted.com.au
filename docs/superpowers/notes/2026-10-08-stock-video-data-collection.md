# Stock-report videos: what data collection needs

A running record of what building and running the stock-report video pipeline reveals about how Shorted collects and serves data. Each finding has its evidence and a recommendation.

**Contributors:**
- The pipeline's own reflection stage writes `shorted-gaps/backlog.md` in the studio. This document holds the conclusions drawn from it.
- Each `/stock-report-video` run adds anything new (see the skill).
- The build of the pipeline adds what it finds along the way.

Design: `docs/superpowers/specs/2026-10-07-stock-report-video-design.md`.
Plan: `docs/superpowers/plans/2026-10-07-stock-report-video-phase1.md`.

## Summary (8 Oct 2026)

| # | Finding | Fixed in the pipeline? | Recommended fix in Shorted |
| --- | --- | --- | --- |
| 1 | The MCP server cannot serve five of the dossier's sections | Recorded on every run (MCP pass) | Add tools, or one briefing tool (see 11) |
| 2 | Share counts travel as 32-bit floats | No | Make the proto fields `int64` or `double` |
| 3 | `GetStock` lacks as-at dates for DRO | No | Populate `last_reported_date` and `final_close_date` |
| 4 | No parsed latest filing for DRO, BHP or CBA; only 3 of the top 30 shorts have one | Falls back to the newest vendor period | Let short interest steer the extractor; audit why mega caps miss |
| 5 | No guidance or dividends for DRO | The outlook chapter drops | Follows from 4 |
| 6 | Brand casing is lost ("Droneshield") | Yes (casing from the summary) | Store a display name |
| 7 | The headquarters is only a raw address | Yes ("Sydney, NSW") | Store city and state |
| 8 | Industry peers are generic for niche companies | Yes (similarity graph) | Offer similar-company peers |
| 9 | The news feed mixes announcements, news and advice-bait listicles | Yes (filtered) | Tag content type at ingest |
| 10 | There is no forward calendar | No ("watch" shows recent events) | Add upcoming events |
| 11 | A dossier takes 32 calls against a 30-a-minute anonymous limit | Paced and backed off | One `GetStockBriefing` call and MCP tool |
| 12 | `GetTopShorts` ignores `product_codes` when `summary_only` is set | Asks for the scoped series instead | Honour the codes on the summary path |
| 13 | `GetDirectorTrades` took over 60 s once, while MCP answered | Network errors retried | Investigate the cold path; add a timeout budget |
| 14 | Dividends carry no currency; unknown franking is stored as 0 | USD reporters' dividends marked untrusted; 0% franking never shown | Store the declared currency; make franking nullable |
| 15 | `GetDividendHistory` is empty for every major checked | The outlook chapter loses its dividend card | Check the announcements dividend parser and backfill |
| 16 | The similarity graph lists a company's own hybrid securities as peers | Falls back to industry peers | Exclude the issuer's own securities from `similar_companies` |
| 17 | `GetDividendHistory.trailing_yield` is a five-year sum of dollar amounts, not a yield | Not used | Divide a 12-month sum by the price, or drop the field |
| 18 | The event timeline lists each announcement twice, a day apart, under a category slug; trade events show unknown amounts as "$0.00" | Yes (headline from `detail`, echoes dropped, trades left to insiders) | One row per announcement with its headline; Sydney dates; no "$0.00" |
| 19 | Director trades: "Unknown Director" rows, dealings listed twice, implausible share counts | Partly (unknown name is none; echoes dropped) | Parse the director's name and amounts from the 3Y; de-duplicate at ingest |
| 20 | Quality ratios are on a TTM basis while the result shown is the annual one | Yes (recomputed from the period, or refused) | Serve ratios per period |
| 21 | Report highlights store the text "null" and put guidance in another same-day report | Yes (forward guidance from the filing's own report) | Never store "null"; per-metric confidence and period |
| 22 | Routine ASX notices (3Y, quotation, substantial holder) are a third of the timeline | Yes (filtered) | Flag routine notices at ingest from the ASX document type |
| 23 | Dates mix UTC and Sydney across endpoints (news, timeline, MCP) | Yes for news timestamps; not for date-only fields | Serve Sydney dates, or timestamps with a zone, everywhere |
| 24 | Shorted holds a bank's net interest income, assets, equity, ROE and ROA, but none of the measures that explain a bank (NIM, CET1, cost-to-income, impairments, loans, deposits) | Partly: the dossier now carries the bank lines Shorted has (CBA's balance-sheet chapter returns); the bank measures need the extractor (bank-data spec) | Extract bank measures from results filings; serve APRA's per-bank statistics (`docs/superpowers/specs/2026-10-08-bank-data-design.md` on branch `feat/bank-data`, awaiting review) |
| 25 | `GetDirectorTrades` returns one page (`limit`) with no way to tell it was truncated, and keeps each 3Y headline's seed row ("Unknown Director", "buy", no amounts) beside the parsed dealing | Yes: a 90-day net is withheld when the page is all inside the window; echoes are matched on their shared announcement id | Return a `has_more` flag or a date-ranged query; stop the crawler re-inserting seed rows (bank-data spec, phase E) |
| 26 | The pipeline's own headless captures of shorted.com.au hit Cloudflare's managed challenge unless they present a normal browser user agent | Yes (a Chrome user agent) | A Terraform-managed WAF skip for first-party automation, keyed on a secret header like the testing bypass |
| 27 | The advice-bait filter missed DRO's top story ("Is This the Buying Opportunity Investors Are Missing?") in news and events alike | No: the DRO run used neither list | Classify at ingest (finding 9) |
| 28 | DRO's half-year to 30 Jun 2026 is unparsed six weeks after filing, yet Shorted's own TTM row implies it within A$0.1M | Falls back to FY2025 and says the half is not covered | Find why it was not extracted; derive a half from TTM − annual + prior half |
| 29 | Director trades: a possibly double-counted sale, untyped "other" dealings, and no roles | No (the possible duplicate was not among the five rows shown) | Reconcile sales against the 3Y holdings; store the nature of change and each director's role |
| 30 | An empty dividend history cannot say "pays none", and a NULL growth figure cannot say why | No: `reflect` files both as missing data | Serve "no dividend declared" from the filing; give each NULL growth figure a reason |
| 31 | CBA's full-year result is unparsed two months on; with DRO's half (28), neither real run had its company's latest result | Falls back to the vendor year; the outlook chapter drops | Find what the extractor did with the August filings; let a newer results document outrank an older parsed one |
| 32 | Every CBA signal carries the same ten citations, all Gemini grounding redirects; some dates are bare years, some awards date from 2017–2022 | Bare-year dates become none; the CBA cuts used no signals | Cite each signal's own sources by the publisher's URL; ISO dates; age out old awards |
| 33 | `GetEventTimeline` stops at 200 rows and cannot filter by type: 52 days for CBA | No | A type filter or a cursor |
| 34 | A stock outside the first page of `GetTopShorts` has no ASX-wide short rank | No ("outside the top 100") | `short_rank` and the count ranked on `GetStock` |
| 35 | Director trades: odd lots typed as option exercises, a price stored as a value, and exercise values at market price | Partly (the 90-day net counts buys and sells only) | Check value = shares × price; keep consideration and market value apart (29) |
| 36 | Peer and stock names are ASIC product names ("Anz Group Holdings", "Bank Of Queensland Limited.") | No | Serve the company-metadata name (6) |
| — | The API and MCP agree on every short-series point for DRO, BHP, CBA and TLX (253 shared dates each) | Parity now compares by date | — |

## Findings

### 1. An AI client on the MCP server could not make this video

*Evidence (8 Oct, source of `services/shorts/internal/mcp/tools_*.go`, and a live `tools/call`):* the MCP server has tools for:
- the stock and its details;
- short history;
- prices;
- fundamentals;
- peers;
- director trades;
- news.

It has none for:
- dividend history;
- the event timeline;
- stock signals;
- one stock's strategy fit (`list_strategies` and `get_strategy_picks` rank picks);
- the latest filing.

`get_stock_fundamentals` returns periods, growth, quality and coverage. It drops the RPC's `latest_filing` (title, date, URL, digest, confidence). So Claude or ChatGPT on the Shorted connector cannot build a results walkthrough's outlook or "what to watch" chapters.

*Recommendation:* expose these through MCP. The `tools/list` payload is at 89,495 of its 90,112-byte budget, so one `get_stock_briefing` tool (see 11) is the affordable shape. Every filing-derived field must keep going through `extractiontrust`.

*In the pipeline:* the MCP pass records this coverage on every run (`artifacts/mcp.json`). Reflection files each missing section as an `mcp_gap`, weighted by whether the video used it.

### 2. Share counts are 32-bit floats

*Evidence:* `stocks.v1alpha1.Stock.reported_short_positions` and `total_product_in_issue` are `float`. For DRO the Connect JSON reads 137867140 and 925339700, and MCP's `get_stock` text says "137867136 of 925339712 shares". Both are float32 roundings, at a spacing of 8 and 64 shares at those sizes, so the true counts are not recoverable from either surface. MCP prints them with false precision.

*Recommendation:* carry counts as `int64` (or `double`) end to end. Video copy rounds to "137.9M", so the videos are unaffected; API and MCP consumers are not.

### 3. `GetStock` has no as-at dates for DRO

*Evidence:* the DRO response has no `last_reported_date`, `final_close` or `final_close_date`. Shares on issue and days to cover therefore have no as-at date in the dossier, and the videos must show one for every figure.

*Recommendation:* populate these fields, or document when they are legitimately absent.

### 4. The most-shorted stock has no parsed latest filing

*Evidence:* DRO is ranked #1 by short interest at 14.90%, yet `GetStockFundamentals` reports `has_latest_filing: false`. Its newest flow periods are the year to 31 Dec 2025 (Yahoo) and the half to 30 Jun 2025 (a filing). The half to 30 Jun 2026, reported in late August, is missing. The video's result chapter falls back to a period nine months old.

*Wider evidence (8 Oct, fixture recording):*
- BHP and CBA, two of the largest ASX companies, also report `has_latest_filing: false`.
- A read-only probe of the 30 most-shorted stocks found only TLX, ELD and CU6 with a parsed latest filing.
- The Go side sets the flag only when `selectLatestFiling` finds a results document whose digest confidence is at least 0.6, with no few-shot echo, a matching entity, and the same period as the newest flow period. So a filing can exist and still be dropped by any one of those conditions.

*Recommendation:*
- The financial-report extractor ranks companies by recency and market cap. Add short-interest rank (say, the top 100 most-shorted): these are the stocks people make content about, and the ones the newsroom and the videos cover.
- Separately, audit `selectLatestFiling` (`services/shorts/internal/services/shorts/latest_filing.go`). It accepts a filing only when its period equals the stock's newest vendor flow period.
  - DRO's FY2025 annual results (filed 25 Feb 2026) and CBA's H1 FY26 half-year (11 Feb 2026) are both parsed with digest confidence 1 and appear in `GetStockFinancialHighlights`.
  - Yet both stocks report `has_latest_filing: false`. A newer vendor row (for example a TTM or later half from Yahoo) makes a correctly parsed filing look stale.
  - BHP has no digested reports at all.
  - Matching on the newest *reported* period, or exposing the latest parsed filing with its period so the caller can decide, would surface them.

*In the pipeline:* the fixtures now include TLX, a real stock with a parsed filing, so the filing path is tested against real data.

### 5. No guidance or dividend history for DRO

*Evidence:* there is no `guidance` metric in `GetStockFinancialHighlights` (no recent filing; see 4), and DRO pays no dividend. The outlook chapter drops, which is the designed behaviour.

*Recommendation:* none beyond 4.

### 6. Names lose their brand casing

*Evidence:* `GetStockDetails.company_name` is "Droneshield", while the company's own summary says "DroneShield". Titles and narration would carry the wrong casing.

*Pipeline fix (8 Oct):* the dossier takes the casing from the summary when the two differ only in case (`display_name`).

*Recommendation:* store a `display_name` in company metadata, set by enrichment or by brandbrain's brand crawl.

### 7. The headquarters is a raw address

*Evidence:* "Level 5, 126 Phillip Street, SYDNEY, NSW, AUSTRALIA, 2000". The first dry run narrated it in full.

*Pipeline fix:* `company.headquarters` is now "City, STATE" (`hq_city`). The full address stays in `company.address` and is never narrated.

*Recommendation:* store `hq_city` and `hq_state`; housing and economy pages could use them too.

### 8. Industry peers are generic for niche companies

*Evidence:*
- `GetPeerComparison` draws DRO's peers from its GICS industry group (Capital Goods): Seven Group, IFT, Reece, Worley, Ventia, NRW, Fletcher and RWC.
- `GetStockGraph.similar_companies` names the real comparables: Electro Optic Systems, Mobilicom and AML3D, with similarity scores but no short data.
- The first dry run's "crowding against peers" chart set DRO against plumbing and engineering firms, which overstated how unusual its short interest is.

*Pipeline fix:* when the graph names similar companies, one `GetTopShorts` call scoped to their codes (`product_codes`, full series; see 12) fetches their short positions. The dossier ignores any row it did not ask for. It uses that set when at least three have data, and `peers.basis` says which set was used. For DRO: Electro Optic Systems 10.2%, Elsight 3.0%, AML3D 0.2%; the other three similar companies have no ASIC short position.

*Recommendation:* offer a similar-company basis in `GetPeerComparison` and MCP's `get_peer_comparison`.

### 9. The news feed mixes announcements, news and advice bait

*Evidence (DRO, 12 latest articles):*
- Two are Motley Fool advice-bait questions: "Should I invest $1,000 into DroneShield shares?" and "Should I buy DroneShield shares after big US news?".
- One is a Simply Wall St valuation call ("Could Be 32% Undervalued").
- All three are tagged `neutral`.
- Google News items end in " - Publisher".
- Relevance is 0.5 for every media article and 0.9 for every ASX announcement, so it does not tell a feature from a passing mention.
- The event timeline repeats the same headlines as `news` events.

*Across the four recorded tickers (7 Oct):* the dossier left out 5 (DRO), 7 (BHP), 9 (CBA) and 6 (TLX) of the news items, and 10–20 of each 30-row timeline. The patterns are recurring formats rather than one-offs:
- "Buy, hold, sell: …";
- "Which ASX share is the stronger buy?";
- "Expert names … as top buys";
- "Could be 30% overvalued";
- "Shares look reasonable";
- "Has CommBank bottomed?";
- "Is the only way up from here?".

A regex can only chase these formats one at a time.

*Pipeline fix:* the dossier leaves out the following from news and events alike, and strips the publisher suffix (Google News items only):
- advice bait;
- ratings and broker calls;
- valuation opinions;
- price calls;
- routine ASX notices;
- low-relevance articles.

The value's note says how many were left out. The storyboard gate also lints every bound third-party headline and warns on anything that reads as advice.

*Recommendation (stronger now):* classify each article at ingest. The news aggregator already calls Gemini for sentiment. The same call can return a kind (factual, opinion, advice, rating, routine notice), and the API can filter on it. Every surface needs this, not just video: the stock page's news card and the newsroom show the same items.

*Recommendation:*
- Tag `content_type` at ingest (announcement, news, opinion, listicle) and strip the suffix there.
- Make `relevance_score` discriminate within media articles.
- Treat advice-bait listicles as a source-quality signal for the newsroom as well.

### 10. There is no forward calendar

*Evidence:* `GetEventTimeline` looks back (`days_back`) and mixes news with announcements. Nothing in Shorted gives the next reporting date, the AGM or the next ex-dividend date. The video's "what to watch" chapter can only show recent events and the stock-picker's read.

*Recommendation:* add upcoming corporate events, from the ASX calendar and the company's own reporting dates.

### 11. One dossier costs 32 calls against a 30-a-minute limit

*Evidence:* the dossier makes 22 Connect calls, plus one dependent peers call, plus 9 MCP calls. `/mcp` answered with `x-ratelimit-limit: 30` for an anonymous caller. The pipeline paces MCP at one call per 2.2 s and backs off on 429 or on the 401 challenge.

*Recommendation:* a `GetStockBriefing` RPC, and a matching MCP tool, would make this one call and solve finding 1 at the same time. It would assemble the dossier's bundle server-side with one consistent as-of date, through the trust funnel, and cache it the way `GetTopShorts` is cached. Short of that, give the pipeline an API token for its runs.

### 12. `GetTopShorts` ignores `product_codes` when `summary_only` is set

*Evidence (8 Oct, live, then the source):*
- A `GetTopShorts` request with `summaryOnly: true` and `productCodes: [D13, ELSR, ELS, EOS, MOB, AL3]` returned DRO, LOT, BOE, IPX, PLS and ZIP: the top-six list, not the requested codes.
- `services/shorts/internal/store/shorts/getTopshorts.go`: the summary path (`if summaryOnly`, line 72) reads `mv_top_shorts` with a limit and offset and returns before the `productCodes` override, which only applies to the full-series path (line 201).
- The service already fingerprints the codes into its cache key, so the response looks scoped but is not. A caller cannot tell.

*Recommendation:* filter `mv_top_shorts` by `product_code = ANY($codes)` on the summary path, and add a test that a code-scoped summary request returns only those codes.

*In the pipeline:* the peers call asks for the scoped series (`summaryOnly: false`, one month) and ignores rows it did not ask for.

### 13. `GetDirectorTrades` exceeded 60 s once

*Evidence (8 Oct, about 08:15 AEST):* while recording fixtures, the Connect `GetDirectorTrades` call for DRO timed out after 60 s. MCP's `get_director_trades`, which calls the same server method in process, returned 20 trades moments later. A re-run a few minutes later answered normally.

*Recommendation:* look at the uncached path for director trades (the cold-cache cost), and give public RPCs a server-side timeout budget, so a slow query fails fast rather than holding the client.

*In the pipeline:* both clients now retry timeouts and dropped connections.

### 14. Dividend amounts have no currency, and unknown franking reads as unfranked

*Evidence (8 Oct, from the source):*
- `dividend_history` (migration 000025) has `amount_per_share DECIMAL(10, 6)` and no currency column. The amounts are parsed from ASX announcements (`services/jobs/internal/jobs/announcements/parser_dividend.go`).
- Companies that report in US dollars (BHP, RIO, WDS, S32) declare their dividends in US cents, so an amount for them could be in either currency. Nothing in the data says which.
- `franking_percentage DECIMAL(5, 2) DEFAULT 0.0` means an announcement whose franking was not parsed is indistinguishable from an unfranked dividend. proto3 then drops the zero from the JSON entirely.

*Recommendation:* store the declared currency, and make franking nullable (unknown ≠ 0, as the fundamentals rules already require).

*In the pipeline:* `dividends.history` is marked untrusted when the company reports in a currency other than AUD, so no video states a dividend in a currency it cannot verify. The dividend rows show a franking tag only when franking is above zero.

### 15. Dividend history is empty for every major checked

*Evidence (8 Oct, fixture recording):* `GetDividendHistory` returned an empty response for DRO, BHP, CBA, WBC, ANZ, NAB, WES, FMG and CSL. Most of these pay dividends twice a year. DRO genuinely pays none; the others do.

*Recommendation:* check that the announcements job's dividend parser (`parser_dividend.go`) is running and writing to `dividend_history` in production, then backfill. Today no video can show a payout history, and the `/shorts/<code>` dividend card presumably shows nothing either.

### 16. The similarity graph lists a company's own securities as its peers

*Evidence (8 Oct):*
- For CBA, `GetStockGraph.similar_companies` is CBAN, CBAHA, CNGHA, CBAR, CBAPG and CBAPC: CBA's own hybrid and capital-notes securities, not WBC, NAB or ANZ.
- For BHP it includes BHPN.
- None of these has an ASIC short position, so the similar-peer set comes back empty and the dossier falls back to industry peers.

*Recommendation:* exclude an issuer's own listed securities (same issuer, or the code prefix) from `similar_companies`.

### 17. `trailing_yield` is not a yield

*Evidence (8 Oct, from the source and the fixtures):* `GetDividendHistory.trailing_yield` sums every amount in the request window (five years here) and is never divided by a price. A video that bound it would have stated a dollar sum as a percentage.

*Recommendation:* compute a 12-month sum over the latest price (and say so in the field's comment), or drop the field.

*In the pipeline:* the dossier has no trailing yield; the storyboard director's path list no longer offers it.

### 18. The event timeline repeats announcements, hides their headlines, and shows unknown amounts as "$0.00"

*Evidence (7 Oct fixtures):*
- An `announcement` event's `title` is its category slug ("other", "director_dealing"). The headline is in `detail`.
- The same announcement comes back a second time as a `news` event with the headline as its title and "other announcement" as its detail, dated a day earlier. The news copy carries the UTC date and the announcement the Sydney one.
- `director_trade` events render an undisclosed value as "$0.00" (CBA: four director buys on 6 Oct, all "$0.00").

*Recommendation:* one row per announcement with its headline as the title. Sydney dates throughout. Unknown amounts left empty, never zero.

*In the pipeline:*
- An announcement's title is taken from `detail`.
- A headline repeated within 7 days is shown once.
- Trade events are left to the insiders section, where an unknown amount stays unknown.

### 19. Director trades: unknown names, dealings listed twice, implausible counts

*Evidence (7 Oct fixtures):*
- **Unknown names.** 8 of DRO's 20 trades are "Unknown Director" with no shares, price or value.
- **Dealings listed twice.** DRO's 12 Nov sells appear twice with slightly different totals (Oleg Vornik A$49,470,035.41 and A$49,469,973; Peter James likewise). TLX's 24 Sep buy by David Gill (11,800 shares, A$133,458) is followed by an amount-less "D Gill" buy the next day, which is the 3Y notice parsed again.
- **Implausible counts.** CBA's option exercises on 29 Sep record 1, 2, 9 and 51 shares.

*Recommendation:*
- Parse the director's name and the amounts from the Appendix 3Y itself.
- De-duplicate on (director, date, type, shares) at ingest.
- Reject counts that cannot be right.

*In the pipeline:*
- "Unknown Director" becomes no name.
- An exact repeat, or an initials-only echo without amounts within 7 days, is shown once.
- The 90-day net value is missing unless every buy and sell discloses its value.

### 20. Quality ratios are on a different basis from the result shown

*Evidence:* DRO's latest full-year result ends 31 Dec 2025, but `GetStockFundamentals.quality` is computed on a TTM basis to 30 Jun 2026. Its margins and ROE describe a different 12 months from the revenue and profit beside them. BHP's quality basis is the annual period, so it matches.

*Recommendation:* serve the ratios per period (each `periods[]` row with its own margins, conversion and ROE), so a caller can pick the one that matches the result it shows.

*In the pipeline:*
- A ratio is used only when the quality basis (type and end) is the result period.
- Otherwise it is recomputed from that period's own statements, or refused with a note naming the other basis.
- Net debt is dated with the balance date.

### 21. Report highlights store "null" quotes and split guidance across reports

*Evidence:*
- `GetStockFinancialHighlights` guidance metrics sometimes carry the literal string "null" as `sourceText`.
- The real outlook sentence can sit in a different report filed the same day (the investor presentation rather than the annual report).
- `confidence` belongs to the whole digest, not to a metric.

*Recommendation:*
- Never store "null".
- Give each metric its own confidence and a populated `period` attribute.

*In the pipeline:*
- Guidance is a verbatim quote for a period after the result.
- It comes from the filing's own report first, then the other reports from the same day.
- It is never blank or "null", and never older than 400 days.
- TLX's reads "Telix provides FY 2026 Group Revenue guidance of US$950 million to US$970 million."

### 22. Routine ASX notices fill the timeline

*Evidence:* across the four tickers, a third of the event rows are administrative notices. Examples are Appendix 3Y, applications for quotation, substantial-holder notices, notifications of cessation and unquoted securities, trading-policy updates and listing-rule waivers.

*Recommendation:* flag routine notices at ingest from the ASX document type. They belong in an announcements list, not in news.

### 23. Dates mix UTC and Sydney time

*Evidence:*
- `GetStockNews` returns UTC timestamps. An ASX announcement released at 08:30 AEST is 22:30 UTC the day before.
- `GetEventTimeline` returns date-only fields: the UTC date for news rows and the Sydney date for announcements.
- MCP's `get_stock_news` returns a UTC date only, so 21 of 44 shared headlines are a day off against Sydney dates.

*Recommendation:* serve Sydney dates, or timestamps with a zone, on every surface.

*In the pipeline:* news timestamps are converted to Sydney dates. Date-only fields cannot be corrected.

### 24. Banks: Shorted has the headline lines, not the measures that explain a bank

*What Shorted already holds (CBA, FY to 30 Jun 2026, Yahoo statements via `GetStockFundamentals`):*
- net interest income A$25.6bn of A$29.9bn revenue;
- interest expense A$40.1bn;
- total assets A$1.45tn and total equity A$78.7bn;
- NPAT A$10.9bn;
- from the quality view: ROE 13.8%, ROA 0.77%, payout ratio 76% and price-to-book 3.2.

*What the pipeline did with it:* nothing. The dossier carried only the generic result lines. For a lender, free cash flow, cash, debt and the margins mean something else, so they are rightly withheld. That left CBA's "cash" chapter empty, and it dropped. This is a pipeline gap, not a data gap.

*What Shorted lacks:*
- net interest margin;
- CET1 capital ratio;
- cost-to-income;
- loan impairment expense (and the loss rate);
- gross loans and customer deposits, and their growth;
- cash NPAT, which banks lead with.

Every bank's results announcement states these on page one. The filing extractor already reads them: it parsed CBA's 2026 half-year profit announcement on 11 Feb. But its numeric vocabulary is only `revenue`, `net_profit`, `eps`, `dividend`, `cash_flow` and `ebitda` (`services/report-extractor/extract.py`), so the bank measures in those documents are never captured.

*Recommendation:*
1. Add bank classes to the extractor's vocabulary, each with its period and under the same grounding rules (`extractiontrust`):
   - `net_interest_margin`, `cet1_ratio`, `cost_to_income`;
   - `loan_impairment_expense`, `gross_loans`, `customer_deposits`;
   - `cash_npat`.
2. Serve them as a typed bank block on `GetStockFundamentals` and on MCP's `get_stock_fundamentals`.
3. Later, add APRA's monthly authorised deposit-taking institution (ADI) statistics for per-bank loan and deposit series (licence to confirm first).

*In the pipeline (planned):* the dossier carries a bank block from the lines Shorted already has. For a bank, the cash chapter becomes a balance-sheet chapter: net interest income and its growth, ROE, ROA, assets, equity and payout. The extracted bank measures will join that chapter when Shorted serves them.

### 27. The advice-bait filter missed the top story

*Evidence (9 Oct, DRO dossier):* the newest row of both `news.items` and `events.items` was "DroneShield (ASX:DRO) Is Down 52% Is This the Buying Opportunity Investors Are Missing?". The dossier's advice-bait pattern has no "buying opportunity", so the row passed both filters.

*In the pipeline:* not fixed. A list card shows its rows from the top and cannot skip one, so the DRO run used neither list. Its news chapter bound the director ledger, the ASIC signal and one announcement title instead. Adding the phrase to the pattern fixes this headline only.

*Recommendation:* finding 9's classification at ingest. Until then, each new headline format costs a video its news list.

*Second run (CBA, 10 Oct):* the dossier left out 9 of 12 news items: three Motley Fool advice-bait questions ("Are CBA shares still worth buying near $150?"), three Appendix 3Y notices and three others. Of the three it kept, one is a forecast ("CBA Shares Slide Back Below A$150 as Bear Market Territory Looms") and one an opinion piece ("ASX Dividend Stocks: Why (ASX:CBA) Looks Different Now"). Again neither list could be shown; the news chapter quoted two event rows one at a time.

### 28. DRO's half-year is unparsed six weeks after filing, though Shorted's own TTM row implies it

*Evidence (9 Oct):*
- DroneShield filed its half-year to 30 Jun 2026 on 26 Aug: revenue A$125.8M, up 74%, and a statutory loss of A$32.2M. `GetStockFinancialHighlights` still ends at the FY2025 Appendix 4E (25 Feb 2026), and `GetStockFundamentals` has no half to 30 Jun 2026.
- `GetStockFundamentals` does have a Yahoo TTM row to 30 Jun 2026: revenue A$270.0M and NPAT −A$30.8M. TTM − FY2025 + H1 2025, all three stored, gives revenue A$125.7M and NPAT −A$32.3M. That is within A$0.1M of the reported half.
- The A$0.1M comes from the H1 2025 row, which stores the filing's rounded headline (A$72.3M, A$2.1M) rather than the statement's A$72,324k and A$2,123k.
- So the result chapter showed FY2025, a profit year, when the half since then was a loss. Shorted's TTM quality ratios (finding 20) already include that loss; its result does not.
- `CLAUDE.md` says the extractor takes filings from the last 45 days first. 26 Aug is 45 days before 10 Oct, so from now on this filing competes in the later buckets.

*Recommendation:*
- Find out why the 26 Aug filing was not extracted, or was withheld by `extractiontrust`, during its 45 days. DRO's rows in `financial_report_extractions` will say which.
- When the TTM, the annual and the prior half all exist in one currency, derive the half as TTM − annual + prior half and mark it `derived:ttm` in `field_sources`. That would have served this result since August.
- Store the statement figure rather than the rounded headline when a filing gives both.
- Finding 4's short-interest priority applies: DRO is the most-shorted ASX stock.

*In the pipeline:* the result chapter falls back to the newest vendor period, as designed (finding 4). The narration says "The latest half-year result is not covered here.", and a data wish files the half as a gap.

### 29. Director trades: a possible double count, untyped "other" dealings, and no roles

*Evidence (9 Oct, `GetDirectorTrades` for DRO):*
- **A possible double count.** Jethro Marks exercised 1,460,000 options on 5 Nov 2025. He then sold 1,460,000 shares on 6 Nov (A$3.34 each, A$4,876,406.29) and 1,460,000 again on 12 Nov (A$3.3511 each, A$4,892,545.00). One exercise followed by two sales of exactly that count reads like one sale reported twice. The dates and prices differ, so the pipeline's repeat rule (finding 19) keeps both. Not yet checked against the Appendix 3Y.
- **"Other" says nothing.** Angus Bean, 26 Jun 2026, is "other" for 290,375 shares with no price or value. Oleg Vornik, 23 Jan 2026, is "other" with no shares either. The video's list card can only show them as "other".
- **No roles.** Each row names the director but not their role. DroneShield changed chief executive during 2026, so a viewer cannot tell which sale was the chief executive's.

*Recommendation:*
- Reconcile each sale with the 3Y's holdings before and after; a sale larger than the change in holding is a duplicate.
- Store the 3Y's "nature of change" text and a typed kind: on-market trade, exercise, issue under a plan, or transfer.
- Store each director's role with its start and end dates.

*In the pipeline:* the ledger card shows the newest five rows. The 6 Nov sale is the sixth, so the video did not show it. Directors are named on screen only, never in narration, and a data wish files the roles.

### 30. An empty dividend history cannot say "pays none", and a NULL growth figure cannot say why

*Evidence (10 Oct, DRO run):*
- **Dividends.** DroneShield pays no dividend. Its FY2025 Appendix 4E says "There were no dividends paid, recommended or declared during the current or previous financial year.", and `GetStockFinancialHighlights` holds that sentence as a `dividend` metric with `value_cents` 0. Yet `GetDividendHistory` gives DRO the same empty response it gives BHP and CBA, whose real dividends the parser missed (finding 15). The payout ratio is absent too. Neither surface separates "pays none" from "not collected".
- **Growth.** EPS went from −0.2c to 0.4c. `eps_yoy_pct` is NULL by design when the prior is not positive, and also when a side is missing (`CLAUDE.md`). Both reasons arrive as the same NULL.
- **The effect.** `reflect` filed `dividends.history`, `results.payout_ratio_pct` and `results.eps_yoy_pct` as missing data. The backlog's top row, "any of: results.guidance, dividends.history" (the outlook chapter dropped), mixes a real gap (the guidance in the unparsed half-year; finding 28) with a fact about the company.

*Recommendation:*
- Serve "no dividend declared for <period>" as a positive fact, taken from the filing's own statement through `extractiontrust`, so an empty history means unknown.
- Give each NULL growth figure a reason, for example `prior_not_positive` or `side_missing`.

*In the pipeline:* the dossier holds both EPS values, so it can mark that NULL as structural itself. That is the improvement "The backlog's signal" already asks for.

### 31. CBA's full-year result is unparsed two months on

*Evidence (10 Oct, CBA run and a follow-up read of the public API):*
- `GetStockFinancialHighlights` holds three CBA reports: the 2026 half-year profit announcement (11 Feb 2026) and the 2025 full-year announcement and profit announcement (13 Aug 2025). There is nothing from the year to 30 Jun 2026.
- Shorted's Yahoo rows already hold that year (revenue A$29.9B, NPAT A$10.9B). The result was public by 19 Aug: a Kalkine article that day reports the final dividend ("Inside the $2.70 Fully Franked Payout").
- `GetDividendHistory` is still empty (finding 15), though the half-year report's metrics hold the A$2.35 interim dividend.
- So the outlook chapter dropped, as it did for DRO, whose half-year filing is unparsed too (finding 28). Neither real run had its company's latest result.

*A hypothesis to check:* `CLAUDE.md` describes the extractor's queue as:
1. filings from the last 45 days, newest first;
2. then companies with no parsed filing, by market cap;
3. then the rest, at most 120 a run.

If more results are filed each day of reporting season than a run takes, a mid-August filing stays behind newer ones until its 45 days run out. After that, a company with any parsed filing sorts into the last bucket, behind every company with none; CBA has the half-year. `financial_report_extractions` will show whether CBA's and DRO's filings were tried and dropped, or never reached.

*Recommendation:*
- Findings 4 and 28.
- Rank a results document newer than a company's latest parsed one ahead of the rest, so that a half-year parse cannot hide the full year.

*In the pipeline:* the result chapter uses the vendor year to 30 Jun 2026, the outlook chapter drops, and a data wish files the full-year announcement.

### 32. Signals cite one shared list of grounding redirects

*Evidence (10 Oct, `GetStockSignals` for CBA):*
- **Citations.** All ten signals carry the same ten citations, so no citation can be matched to the signal it supports. Every one is a `vertexaisearch.cloud.google.com/grounding-api-redirect/…` link: a redirect through Gemini's grounding service, not the publisher's URL.
- **Dates.** Two `eventDate` values are bare years ("2025", "2017"). Three rows predate 2025: a 2017 CitySwitch award, Green Star certifications from 2020 and an ISCC certification from 2022.
- **Polarity.** All ten are positive; there is no `adverse` list.
- **Confidence.** It is 0.7 on every row.

*Recommendation:*
- At ingest, keep the grounding supports that tie each statement to its sources. Resolve each redirect to the publisher's URL, and store only those URLs on the signal.
- Store an ISO date, or a date with its precision.
- Age out old awards, or label them as history. A 2017 award is not a current signal.

*In the pipeline:* a bare-year date becomes none. Neither CBA cut used signals.

### 33. The event timeline stops at 200 rows

*Evidence (10 Oct):*
- `GetEventTimeline` caps `limit` at 200 (`services/shorts/internal/services/shorts/event_timeline.go`). Its request has no type filter (`GetEventTimelineRequest` in `stock.proto`).
- For CBA, `daysBack: 62` with `limit: 1000` returned 200 rows, reaching back only to 19 Aug. News rows fill most of them, many of them Kalkine "Highlights" pieces. CBA's mid-August results announcement cannot be reached through the timeline at all.
- The dossier's own request (30 rows over 365 days) covers 1–9 Oct.

*Recommendation:* add a type filter (announcements, or price-sensitive only) or a cursor, and leave news to `GetStockNews`.

### 34. No ASX-wide short rank outside the first page

*Evidence (10 Oct):*
- The dossier ranks a stock by its row in `GetTopShorts` (100 rows, period 3M, summary only).
- CBA is not in those 100, so a video can only say "outside the top 100". The same call with `limit: 500` puts CBA at row 131.
- `GetStock` carries no rank.

*Recommendation:* serve `short_rank` and the number of stocks ranked on `GetStock`, so a caller does not page through the list.

*In the pipeline:* not changed. The long cut says "outside the top 100" and ranks CBA among its bank peers (#4).

### 35. Director trades: odd lots typed as option exercises, and a price stored as a value

*Evidence (10 Oct, `GetDirectorTrades` for CBA):*
- **Odd lots typed as exercises.** Four non-executive directors' Appendix 3Ys, lodged 5 and 6 Oct, are parsed as `exercise_options` on 29 Sep:
  - Kate Howitt, 51 shares, no price;
  - Jane McAloon, 1 share at A$156.45;
  - Alistair Currie, 2 shares at A$156.45 (A$312.90);
  - Julie Galbo, 9 shares at A$17.3833, with a value of A$156.45.

  Non-executive directors are not usually granted options. Odd lots at one price on one day look like dividend reinvestment allocations. This is not yet checked against the 3Ys.
- **A price stored as a value.** Galbo's value is the others' share price, and her price is that value divided by 9. The parser took the price for the value and derived a price from it.
- **Values that mean different things.** The chief executive's 13 Aug row is `exercise_options` for 50,097 shares at A$168.43, valued at A$8,437,681.48. That is the market value of vested shares, not money paid.
- **Seed rows.** Each 3Y also keeps its seed row ("buy", no amounts, dated the day it was lodged; finding 25).

*Recommendation:*
- Store finding 29's nature of change.
- Reject a row whose value is not shares × price, within rounding.
- Keep `value` for consideration paid, and put the market value of a vesting in its own field.

*In the pipeline:* the 90-day net counts buys and sells only. The CBA long cut shows that net (A$37.4K of buys, no sales) rather than the ledger, because the ledger's newest five rows are these.

### 36. Peer and stock names are ASIC product names

*Evidence (10 Oct, CBA):*
- `GetPeerComparison` names the peers "Anz Group Holdings", "Bank Of Queensland Limited.", "Bendigo And Adelaide Bank", "Westpac Banking" and "Mystate".
- `GetStock` names CBA "Commonwealth Bank Of Australia.", while `GetStockDetails` has "Commonwealth Bank of Australia". The first set are ASIC's product names, title-cased.
- The long cut narrates two peers. Captions are the script's own words, so they show "Bendigo And Adelaide Bank" and "Westpac Banking".

*Recommendation:* serve the company-metadata name (finding 6's `display_name`) on `GetPeerComparison` and `GetStock`.

*Smaller (10 Oct, CBA):* the news copy of an ASX notice reads "CBAPJ - Hybrid Security Suspension Upcoming Removal". The timeline's copy of the same notice reads "… Suspension and Upcoming Removal". News ingest seems to drop a word, perhaps an ampersand.

### Fixes in Shorted (11 Oct, PR #703)

The backlog's top three gaps after the CBA run, worked through to their causes:

| Gap | Cause found | Fix | Verified |
| --- | --- | --- | --- |
| Outlook chapter dropped: no dividend history (finding 15) | The announcements job reads only headlines. ASX titles every Appendix 3A.1 notice "Dividend/Distribution - CBA", with no amount, so the job's store step skipped every row. | A capped daily pass (`-dividend-notices`, default 200, newest first) parses each notice PDF already listed in `asx_announcements`. It stores the AUD amount, real ex, record and payment dates, period end, franking (NULL when unstated), the declared currency and amount, and the source URL. A foreign declarer's row waits for the company's stated AUD equivalent, which comes in a later update notice. Migration 000133 is allowlisted and replay-safe. | A throwaway Postgres, the real job, CBA, SUN and BHP for 2026: 43 notices, 38 parsed, 29 rows across 11 codes. CBA: final A$2.70 ex 19 Aug, interim A$2.35 ex 18 Feb. SUN: an ordinary A$0.52 and a special A$0.10. BHP: US$0.99, stored as the stated A$1.379887. A second run selected nothing. |
| `trailing_yield` was a five-year sum (finding 17) | The handler summed every row in the window. | It is now the trailing 12-month dividends per share, in AUD. Rows from the old headline parser (whose ex-date is the announcement date) are withheld. | Unit tests; the new store query was run on the throwaway database. |
| No latest result for CBA or DRO (findings 28, 31) | The extractor's queue can sink a company's newest results document below every never-parsed company once it is 45 days old. | That document now ranks in tier 1, by market cap. | 402 extractor tests pass. Whether this caused CBA's and DRO's misses is unconfirmed: the job's run history could not be read (no access). |
| MCP: no event timeline, signals or strategy fit (finding 1) | Events were a false positive of the studio check: ASX announcements (source `asx`) and news come from `get_stock_news`, and trades from `get_director_trades`. | A new tool, `get_stock_briefing`, serves strategy fit, signals (adverse first, newest first, no grounding-redirect citations), dividends and the latest parsed filing. tools/list went from 91,006 to 93,700 bytes, under a 93 KiB budget. The studio maps events to `get_stock_news`. | MCP tests, including a 5,889-byte worst-case payload; 494 studio tests. |

The notices also confirm finding 35: CBA's update of 21 Sep 2026 sets the DRP price at A$156.45 (field 4A.6). That is the price on the directors' 29 Sep "option exercises", so those rows are dividend reinvestment allocations.

Still open: guidance through MCP; "pays no dividend" as a fact (finding 30); trust-issuer letters such as Vanguard's, which are not Appendix 3A.1 and are recorded as `not_appendix_3a1`. After the deploy, the studio's MCP pass should call `get_stock_briefing` and map strategy, signals, dividends and `results.filing` to it, with fixtures re-recorded from the live tool.

### Smaller MCP findings (8 Oct)

- `list_stock_politicians` leaves `party` empty on many rows, and CBA's `party_counts` lists `OTH` twice (10 and 1).
- The live server lists 29 tools; the repo's `CLAUDE.md` still says 28.
- Two of 36 recording calls stalled for about 96 s before a retry succeeded.

### API and MCP agree

The MCP pass compares headline figures across the two surfaces:
- short %;
- the current percent;
- the latest close;
- revenue and net income;
- the industry peer set;
- director trades;
- news headlines.

For DRO, BHP, CBA and TLX the short series agree point for point on all 253 shared dates. The first version of the pass compared each surface's newest point. It read a mismatch whenever the two reads straddled the daily ASIC load, as the fixtures did (recorded 63–81 minutes apart). It now compares by date and reports which surface runs ahead. Coverage, not consistency, is the MCP gap (finding 1).

## Pipeline-side fixes made while building (8 Oct)

- Prior-period figures were marked stale by the freshness rule. They are a year old by design, so they are now exempt.
- A 404 from an endpoint that exists (e.g. no ATO tax profile for DRO) is now classified as missing data for that stock, not as a missing endpoint.
- The company's name casing, its city and state, headline filtering and similarity peers: see findings 6–9.
- The 1-year price change uses the raw closes the chart draws, not adjusted closes, so the stated move matches the line. It needs at least 330 days of prices.
- Shares on issue and days to cover are dated with the latest short report; a similar peer whose last report is more than a week older than the subject's is left out.
- A section that cannot be built from a malformed response becomes an empty section and a recorded failure; it no longer stops the dossier.
- Banks and insurers have free cash flow, cash and total debt withheld, alongside the ratios Shorted already marks not meaningful.

## The backlog's signal (9 Oct)

`reflect` ranks the data Shorted lacked across runs in `shorted-gaps/backlog.md`.

**What it leaves out:**
- Absences by design: a non-bank's net interest income, a bank's cash-flow measures, and "no buys or sells in 90 days".
- Per-value rows for a section whose endpoint failed. The failed call itself is still filed.

**What it files:**
- A missing bank measure on a bank. This is the evidence for the bank-data work (`feat/bank-data`).
- A director dealing with no disclosed value. The Appendix 3Y states the consideration, so a missing value is a collection gap.
- A withheld filing digest, filed as `low_trust_extraction`.

**Improvement to make:** the dossier should mark a structural absence itself. Today `reflect` classifies the dossier's notes against a closed table, with a test that fails on any unclassified note.

**First real run (DRO, 10 Oct):**
- **A misleading class.** Ranks 2 and 3 are `low_trust_extraction` rows for `results.roa_pct` and `results.roe_pct`. They are not extractions. They are Shorted's TTM quality ratios on a different basis from the result (finding 20). File basis mismatches under their own class.
- **Structural absences filed as gaps.** See finding 30.
- **Stand-in rows.** Four rows from the build's 7 Oct stand-in run (ticker EXM) are still in `gaps.jsonl`: two kit misses, an MCP pass and a guidance wish. Keep stand-in runs out of the ledger.

**Second real run (CBA, 10 Oct):**
- **The top of the backlog held.**
  - Rank 1, score 6: the outlook chapter dropped for both tickers ("any of: results.guidance, dividends.history").
  - Ranks 2–4, score 4 each: the MCP gaps for events, signals and strategy.
  - Two runs make a pattern: neither company's latest result is parsed (finding 31).
- **A wish worded twice is two gaps.**
  - Rows 30 and 31 are the same forward-calendar wish: "upcoming events: the agm and the next reporting date" (CBA) and "upcoming events: the next reporting date and the agm" (DRO).
  - The latest-result wishes (rows 19, 22 and 29) and the news-quality wishes (24, 25) split the same way.
  - A wish is keyed on its lower-cased first 80 characters, so the gaps that recur never accumulate tickers, and the backlog under-ranks exactly them.
  - Give each wish a key from a closed vocabulary (for example `forward_calendar`, `latest_result_unparsed`, `news_content_type`, `director_trade_typing`, `bank_measures`). Rank by the key and keep the text as the note.
- **An empty list read as missing.** `signals.adverse` is filed as missing for CBA because `GetStockSignals` returns no `adverse` key when there is none. "No adverse signal found" and "not collected" look the same, as with dividends (finding 30).
- **No basis mismatch this time.** CBA's quality ratios are on the annual basis of its result, so DRO's two `low_trust_extraction` rows (ROE, ROA) did not recur. They belong to TTM-basis stocks (finding 20).

## Follow-ups after Phase 1 (deferred by the 9 Oct close-out)

**Tests not yet written:**
- Exact-edge tests for the QA thresholds.
- The voice stage's E05 edge test and docstrings.
- The chapters' inclusive bounds.
- A badge-clearance test for long names with a logo.

**Mix:**
- The loudness trim is one-shot.
- The limiter reports its deepest pass, not the cumulative one.
- A stem's peak-limited flag misses shortfalls under 0.5 LU.
- The long cut's mix peaks at 3.2 GB of memory.

**Rendering:** real 4K needs a DPR-aware canvas.

**QA:** deliverables are checked for presence only. Captions can be offset in time by 0.2–0.3 s.

**Voice:** a company-name pronunciation list. The WER check catches a bad pronunciation today.

**First real run (DRO, 10 Oct): what it showed.** QA passed 28 of 28 checks on each cut, after two storyboard fixes and two re-approvals.
- **AAC band:** held. The long cut's audio is 264.8 kb/s and the short's 266.4 kb/s, inside 256 kb/s ±15%.
- **Dates:** every spoken date passed its figure check (for example "5 October 2026" and "12 November 2025"). No ordinal form came up.
- **Cost:**
  - 70 Gemini TTS takes, including 4 pre-tests: 368 s of audio, or 9,192 audio tokens at 25 a second.
  - About US$0.085 at the Standard paid rate of US$9 per million audio tokens. That is the 2026 price; it is US$18 from 1 Jan 2027.
  - Nothing on the free tier. Text input costs a fraction of a cent.
  - 55 of 59 lines passed on their first take.
- **Pace and the word budget:**
  - Gemini `en-au-tutor-5` ran 1.12× the macOS Karen voice, about 2.2 spoken words a second.
  - The long cut's 477 words came to 246 s before minimum holds. At that rate the 270–330 s window holds about 525–640 words, and the storyboard director's 650–750 overruns it.
  - The short's 127 words came to 68 s, so its 60–90 s window holds about 115–170 words, not 150–200.
  - Lower both budgets in `storyboard-director.md`.
- **Voice failures were all wording:**
  - "Shorted" as a sentence's last word. The three takes were heard as "shortage", "Uh, shorted" and "aren't they?". "Shorted" at the start of a sentence passed every time.
  - A three-decimal dollar figure: "1.565 dollars" was heard as "$1.56.5".
  - A comma before a short clause. Gemini rushed the clause, which became a caption cue over 20 characters a second. This was QA's one failure.
- **Pre-testing a reworded line:**
  - `narrate_line`, pointed at a scratch folder, voices and checks a line exactly as the stage does.
  - Copying a passing entry into the project's `assets/audio/lines/` lets the stage use it as cached.
  - So a reworded line is known to pass before the user is asked to approve it again.

**Second real run (CBA, 10 Oct): what it showed.** QA passed 28 of 28 checks on each cut after two storyboard fixes and two re-approvals. The long cut runs 281.6 s and the short 71.7 s. Outputs are in `projects/CBA-2026-10-10/renders/`. Nothing was published.

- **Currency.** The dossier's reporting currency came from Shorted's data (`currency: "AUD"` on the vendor year), not the `or "AUD"` fallback.
- **Cost.** 83 Gemini TTS takes, 5 of them pre-tests: 400 s of audio, about 10,000 audio tokens, about US$0.09 at the 2026 rate. 56 of the first pass's 70 lines passed on their first take.
- **Pace and the word budget.**
  - `en-au-tutor-5` ran at 2.28 spoken words a second (DRO: 2.19).
  - The long cut's 564 words came to 281.6 s and the short's 143 to 71.7 s, which confirms budgets of about 560–600 and 140–150.
  - The timeline warned about eight scenes held 14.4–16.8 s; QA has no hold check.
- **Voice failures, all wording:**
  - **A sum under a million.** "37.4 thousand dollars" was said as "$37,400", so the figure check failed. The `money` format's thousand scale is not something this voice says as written. Keep such sums on the card, or teach the check that 37,400 is 37.4 thousand.
  - **"Shorted's".** The possessive was swallowed twice, heard as "Shorted stock" and "Shorter's stock". Avoid it.
- **A clean take the mix lost.**
  - In the short, "Shorted also runs a stock picker." was heard as "Shorten also runs …".
  - The line opens a scene: about 0.75 s with no speech and a change of bed, so its first word meets music that has not ducked yet. The same sentence passed in the long cut, mid-scene.
  - Removing the scene's page flip did not help. That was tested in a scratch rebuild.
  - QA said `fix_in: score`, but the score is deterministic, so a re-run rebuilds the same mix. The fix was a rewording that opens on a robust word: "The stock picker on Shorted has CBA on watch under every screen."
  - Either QA should say "rephrase the line's opening" for this case, or the score should duck the bed just before a scene's first line.
- **Pre-testing a mix.** A scratch copy of `artifacts/` and `assets/audio/lines/` reproduces QA's speech check without touching the project or its approval, in a few minutes:
  1. Voice the candidate line with `narrate_line`.
  2. Edit the copy's storyboard and `narration.json`.
  3. Run `timeline.write_cut`, `score.score_cut`, `mixdown.mixdown`, then `qa.speech_checks` and `qa.caption_check`.

**Honesty and messages (from the final review, deferred):**
- **An unknown currency is shown as AUD.** `dossier.py:381` (`latest.get("currency") or "AUD"`) and `formatters.py:92` (`v.currency or "AUD"`) do this. It is latent, because every recorded fixture carries a currency. A US$ reporter with the field missing would be shown in A$. Withhold the figure instead of guessing. Fix this before running a company whose reporting currency is not AUD.
- **An API outage reads as "no data".** `cli.py:413` tells the agent the video "cannot be made honestly". On a 5xx, a 429 or a network error, it should say the Shorted API did not answer and to try again. `ShortedDossier.execute` already tells the two apart.
- **QA does not report scenes dropped after approval.** Add one QA line: "scenes approved N, shown M, dropped: ids".
- **`render_all` does not check the staged plates exist** before Remotion starts. The error names the missing path but not the `assets` stage.

**Security:** `assets` passes the whole environment, keys included, to the Node capture script. Pass an allowlist instead (`PATH`, `HOME`, `TMPDIR`, `SHORTED_PLAYWRIGHT_MODULE`, `PLAYWRIGHT_BROWSERS_PATH`), and check it with the first live capture.

**Owner decisions before anything is published:**
- An AI-voice disclosure, per each platform's synthetic-media rules.
- Remotion licence eligibility.
- A human look at every rendered video. Nothing publishes automatically.
