package strategies

// The two CTEs of mv_screener_data (migration 000080) that the shadow parity
// reads as the view-side of the days-to-cover check. The job image carries no
// migrations, so the text is copied here and TestScreenerCTEsMatchMigration
// holds it to 000080 word for word (whitespace aside). Change it only with the
// migration that changes the view.

// latestShortsCTE is the body of 000080's latest_shorts CTE: each code's newest
// qualifying shorts row.
const latestShortsCTE = `
         SELECT DISTINCT ON (shorts."PRODUCT_CODE") shorts."PRODUCT_CODE" AS stock_code,
            shorts."PRODUCT" AS product_name,
            shorts."PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" AS short_pct,
            shorts."REPORTED_SHORT_POSITIONS" AS reported_short_positions,
            shorts."DATE" AS short_date
           FROM shorts
          WHERE ((shorts."PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" > (0)::double precision) AND (shorts."PRODUCT" !~~* '%DEFERRED%'::text) AND (shorts."PRODUCT" !~* 'ETF\M'::text) AND (length(shorts."PRODUCT_CODE") <= 4) AND (shorts."PRODUCT" !~ '[0-9]+(\.[0-9]+)?\s*%'::text) AND ((shorts."TOTAL_PRODUCT_IN_ISSUE" IS NULL) OR (shorts."TOTAL_PRODUCT_IN_ISSUE" >= (5000000)::double precision)))
          ORDER BY shorts."PRODUCT_CODE", shorts."DATE" DESC
`

// avgVolumeCTE is the body of 000080's avg_volume CTE: the mean of the traded
// sessions (volume above zero) in the 35 calendar days up to CURRENT_DATE, as a
// bigint, for a code with at least five of them.
const avgVolumeCTE = `
         SELECT stock_prices.stock_code,
            (avg(stock_prices.volume))::bigint AS avg_volume_20d
           FROM stock_prices
          WHERE ((stock_prices.date >= (CURRENT_DATE - '35 days'::interval)) AND (stock_prices.volume > 0))
          GROUP BY stock_prices.stock_code
         HAVING (count(*) >= 5)
`
