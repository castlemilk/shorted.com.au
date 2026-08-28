# Reading Shorted's data

Interpretation notes for the numbers this server returns. Definitions here are
the ones used on https://shorted.com.au/glossary; the regulatory framing is
summarised from https://shorted.com.au/llms.txt.

## Short interest is a stock, not a flow

Every "percent shorted" figure on this server is a **net short position**
expressed as a percentage of the company's total product in issue. Net means a
reporter's long holdings in the same security are subtracted; aggregate means
individual funds are not identifiable.

It is **not short-sale flow**. It does not say how many shares were sold short
today, or on what volume. A stock can print heavy daily short-sale volume with
flat short interest (intraday and hedging activity that closes out), and it can
print rising short interest on quiet volume. If a question is about *trading
activity*, this data cannot answer it; if it is about *positioning*, it can.

## Everything is T+4

ASIC aggregates reports from every market participant and publishes with a
**T+4 trading-day delay**. So:

- The most recent figure this server returns is already four trading days old,
  and across a weekend or public holidays that is up to a week of calendar time.
- Never describe a short-interest reading as "current", "today's", or "live".
  Say "as at" the date on the observation, which every tool returns.
- Do not attribute a price move on day *n* to a short-interest reading dated
  day *n*: the reading describes positions four trading days earlier.

## The reporting threshold, and what it hides

A holder must report a net short position once it reaches **0.01%** of issued
capital or **$100,000**, whichever is smaller. Below that, positions exist but
are not in this data. A stock showing 0.00% is therefore "no reportable
positions", not "no shorts".

Only ASX-approved short-sell products are eligible. ETFs, bonds and other
non-equity instruments are excluded from the rankings and screeners this server
serves.

## Scale, and what counts as "a lot"

- Typical ASX stocks sit **under 1%**. Above **5%** is genuinely elevated;
  above **10%** puts a stock in a small group that the site treats as heavily
  shorted.
- Percentages are on a **0-100** scale, not 0-1. `4.2` means 4.2%.
- **Days to cover** is reported short positions divided by average daily
  volume: how many days of ordinary trading it would take to buy the position
  back. It is the liquidity half of squeeze risk that a raw percentage misses —
  8% of a heavily traded large cap is a far easier exit than 8% of a
  thinly traded small cap.
- Comparisons are only meaningful against a stock's **own history** and against
  its **sector**. A single cross-sectional number, on its own, says little.

## Things that are routinely misread

- **High short interest is not a prediction.** Much of it is hedging (index,
  convertible, merger-arbitrage), not a directional bet against the company.
- **A fall in short interest is not necessarily bullish.** It can be covering
  into strength, an arbitrage unwinding, or a borrow being recalled.
- **Positions are aggregate.** No tool here can attribute a position to a fund,
  and no data on this server supports naming one.
- **Gaps are gaps.** A missing observation means nothing was reported for that
  date; it does not mean zero.

## Nothing here is financial advice

This is a public data set, aggregated and presented. It carries no
recommendation, and answers built on it should not present one.
