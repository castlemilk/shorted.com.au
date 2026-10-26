# Chat tool-result fixtures

Real results from the chat service's tools, recorded from the live Shorts API.
The chat UI builds its tables and charts against these, so parsers and stories
are tested on what the API actually returns, not on guesses.

## Format

- Each `*.json` file is the **exact result string** that `ToolExecutor.Execute`
  returns for one tool call. The file has no wrapper, no trailing newline and
  no added whitespace. The chat UI receives `result` as this string inside
  `data-shorted-final`, so read the file as text (`fs.readFileSync`, or `?raw`
  in Storybook) and pass that string to the parser. A `JSON.parse` of the text
  gives the same value the component sees.
- Captured on **2026-10-24** from `https://api.shorted.com.au` (anonymous,
  read-only, one request every 1.5 s).
- Every file is compact JSON that parses, and none is cut at the result budget
  (`...(truncated)` would fail the capture).

## How they were captured

The capture is an env-gated test in `services/chat-service/`, skipped by
default. It calls `ToolExecutor.Execute` with the arguments listed below and
writes each result string to this directory. Run it from `services/`:

```bash
CHAT_TOOLS_CAPTURE_FIXTURES="$PWD/../web/src/@/components/chat/__fixtures__/tool-results" \
  GOWORK=off go test -count=1 -v -run TestCaptureToolResultFixtures ./chat-service/
```

The case list is `captureToolFixtures` in
`services/chat-service/tool_fixtures_capture_test.go`. Re-running overwrites the
files with today's live data. Values will change; the shapes should not. If a
shape changes, update the parsers and these notes together.

To re-record only some cases, name their files in `CHAT_TOOLS_CAPTURE_ONLY`, a
comma-separated list. The other fixtures keep the values they were recorded with:

```bash
CHAT_TOOLS_CAPTURE_ONLY=get_director_trades-bhp.json,get_director_trades-bhp-50.json,get_director_trades-glc-none.json \
  CHAT_TOOLS_CAPTURE_FIXTURES="$PWD/../web/src/@/components/chat/__fixtures__/tool-results" \
  GOWORK=off go test -count=1 -v -run TestCaptureToolResultFixtures ./chat-service/
```

## Cases

| File | Tool | Arguments | Bytes | What it shows |
|---|---|---|---|---|
| `get_top_shorts-10.json` | `get_top_shorts` | `limit: 10` | 5840 | 10 rows, each with 8 sparkline points |
| `get_top_shorts-50.json` | `get_top_shorts` | `limit: 50` | 7939 | 50 rows. The 7 highest keep their sparklines; the rest have `points: []` because the budget cleared them. `omittedStocks` is absent |
| `query_short_positions-bhp-1y.json` | `query_short_positions` | `stock_code: BHP, period: 1y` | 6503 | 40 thinned points of 254 observations (`downsampled: true`) |
| `query_short_positions-dro-6m.json` | `query_short_positions` | `stock_code: DRO, period: 6m` | 6544 | 40 thinned points of 130 observations |
| `query_short_positions-glc-3m.json` | `query_short_positions` | `stock_code: GLC, period: 3m` | 718 | Sparse series: 4 points, `totalObservations: 4`, no `downsampled` key |
| `get_peer_comparison-bhp.json` | `get_peer_comparison` | `stock_code: BHP` | 1789 | `subject`, `peers` (5 rows) and `industry` |
| `get_director_trades-bhp.json` | `get_director_trades` | `stock_code: BHP, limit: 10` | 2152 | 10 trades. Several have no share or value fields |
| `get_director_trades-bhp-50.json` | `get_director_trades` | `stock_code: BHP, limit: 50` | 7810 | The budget-trimmed answer: 36 of the 44 trades BHP has. `omittedTrades: 8` and `totalCount: 44` |
| `get_director_trades-glc-none.json` | `get_director_trades` | `stock_code: GLC, limit: 10` | 2 | `{}`: no `trades` key, no `totalCount` and no `omittedTrades`. The empty case |
| `get_stock_details-bhp.json` | `get_stock_details` | `stock_code: BHP` | 2004 | Profile with valuation figures (`marketCap`, `peRatio`, ...) and `keyPeople` |
| `get_economic_series-cash-rate-cpi.json` | `get_economic_series` | `series_keys: [rates.cash_rate_target.aus, cpi.annual_change.all_groups.aus]` (default limit 12) | 1348 | Two series, 12 observations each |
| `get_economic_series-unemployment-nsw.json` | `get_economic_series` | `series_keys: [labour.unemployment_rate.total.nsw.seasadj], limit: 24` | 1416 | One series, 24 observations |

Two cases are **synthetic**, not captured from the API. They cover shapes no live answer
has, and each is written by hand from the same format. They are not in the capture test:

| File | Synthetic because | What it shows |
|---|---|---|
| `query_short_positions-narrow-range.json` | The live series moves by whole tenths of a point, never by a hundredth | `CTX`: ten readings between 15.92 and 15.94, so the chart's axis ticks are a few thousandths apart |
| `get_economic_series-units.json` | The recorded answers carry only percentages | Four series in the units the importers write (`usd_per_barrel`, `units`, `persons`) and one the chat does not know (`widgets_per_frob`), which must read with no unit |

## Shape facts the parsers rely on

- **Top shorts.** Top-level `timeSeries` only. Rows have `productCode`,
  `name` (optional), `latestShortPosition` and `points`, where each point is
  `{timestamp, shortPosition}`. `omittedStocks` is absent here because the rows
  always fit the budget.
- **Short positions.** Top-level `productCode`, `latestShortPosition`,
  `totalObservations`, `points` and an optional `downsampled`. Every point has
  `timestamp`, `shortPosition`, `reportedShortPositions`,
  `totalProductInIssue` and `availableFrom`.
- **Peers.** `subject` and each `peers[]` entry have `stockCode`,
  `companyName`, `industry`, `shortPositionPercent`, `marketCap`, `peRatio`,
  `dividendYield`, `priceChange1m` and `logoUrl`. Some numbers may be absent.
- **Director trades.** `trades[]` entries have `directorName`, `tradeType`
  (`buy`, `exercise_options`, `other`), `tradeDate`, `announcementUrl`, and
  `sharesTraded`, `pricePerShare` and `totalValue` where the trade has them. The
  Go shaper drops the per-row `stockCode` and `id`, and writes `sharesTraded` as
  a number. A row for "Unknown Director" has none of the share or value fields.
  `totalCount` is the number the API returned. `omittedTrades` counts the trades
  the 8000-byte budget dropped from the end, and is absent when none were. An
  empty answer is `{}`.
- **Stock details.** Flat object: `productCode`, `companyName`, `industry`,
  valuation figures, `summary`, `riskFactors` (strings), `keyPeople`
  (`{name, role}`). Missing fields are omitted, not null.
- **Economic series.** Top-level `series[]`. Each item has `key`, `name`,
  `unit`, `frequency` and `observations[]` of `{period, value}`. There is no
  `info` wrapper.

## Not covered by a real capture

- No fixture carries `omittedStocks`. At 50 rows the top-shorts result is far
  under the budget, so that parser case needs a synthetic one (mark it as
  synthetic). A budget-trimmed director-trades answer is real: see
  `get_director_trades-bhp-50.json`, which carries `omittedTrades`.
- No economic-series result has more than two series or more than 24
  observations. Tests for the series cap should use a synthetic case.
- No live answer has a short-position range under a tenth of a point, or an
  economic unit other than `percent`. The two synthetic cases above cover them.
