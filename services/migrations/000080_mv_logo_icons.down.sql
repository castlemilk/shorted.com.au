DROP MATERIALIZED VIEW IF EXISTS mv_screener_data;

CREATE MATERIALIZED VIEW mv_screener_data AS
WITH latest_shorts AS (
         SELECT DISTINCT ON (shorts."PRODUCT_CODE") shorts."PRODUCT_CODE" AS stock_code,
            shorts."PRODUCT" AS product_name,
            shorts."PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" AS short_pct,
            shorts."REPORTED_SHORT_POSITIONS" AS reported_short_positions,
            shorts."DATE" AS short_date
           FROM shorts
          WHERE ((shorts."PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" > (0)::double precision) AND (shorts."PRODUCT" !~~* '%DEFERRED%'::text) AND (shorts."PRODUCT" !~* 'ETF\M'::text) AND (length(shorts."PRODUCT_CODE") <= 4) AND (shorts."PRODUCT" !~ '[0-9]+(\.[0-9]+)?\s*%'::text) AND ((shorts."TOTAL_PRODUCT_IN_ISSUE" IS NULL) OR (shorts."TOTAL_PRODUCT_IN_ISSUE" >= (5000000)::double precision)))
          ORDER BY shorts."PRODUCT_CODE", shorts."DATE" DESC
        ), short_change AS (
         SELECT ls_1.stock_code,
            (ls_1.short_pct - COALESCE(prev."PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS", ls_1.short_pct)) AS short_pct_change_4w
           FROM (latest_shorts ls_1
             LEFT JOIN LATERAL ( SELECT shorts."PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS"
                   FROM shorts
                  WHERE ((shorts."PRODUCT_CODE" = ls_1.stock_code) AND (shorts."DATE" <= (ls_1.short_date - '28 days'::interval)))
                  ORDER BY shorts."DATE" DESC
                 LIMIT 1) prev ON (true))
        ), latest_price AS (
         SELECT DISTINCT ON (stock_prices.stock_code) stock_prices.stock_code,
            stock_prices.close AS latest_price,
            stock_prices.volume AS latest_volume,
            stock_prices.date AS price_date
           FROM stock_prices
          ORDER BY stock_prices.stock_code, stock_prices.date DESC
        ), avg_volume AS (
         SELECT stock_prices.stock_code,
            (avg(stock_prices.volume))::bigint AS avg_volume_20d
           FROM stock_prices
          WHERE ((stock_prices.date >= (CURRENT_DATE - '35 days'::interval)) AND (stock_prices.volume > 0))
          GROUP BY stock_prices.stock_code
         HAVING (count(*) >= 5)
        ), price_change AS (
         SELECT lp_1.stock_code,
                CASE
                    WHEN ((prev.close IS NOT NULL) AND (prev.close > (0)::numeric)) THEN (((lp_1.latest_price - prev.close) / prev.close) * (100)::numeric)
                    ELSE (0)::numeric
                END AS price_change_1m
           FROM (latest_price lp_1
             LEFT JOIN LATERAL ( SELECT stock_prices.close
                   FROM stock_prices
                  WHERE (((stock_prices.stock_code)::text = (lp_1.stock_code)::text) AND (stock_prices.date <= (lp_1.price_date - '30 days'::interval)))
                  ORDER BY stock_prices.date DESC
                 LIMIT 1) prev ON (true))
        ), director_summary AS (
         SELECT director_trades.stock_code,
            (COALESCE(sum(
                CASE
                    WHEN ((director_trades.trade_type)::text = 'buy'::text) THEN COALESCE(director_trades.total_value, (0)::numeric)
                    ELSE (0)::numeric
                END), (0)::numeric) - COALESCE(sum(
                CASE
                    WHEN ((director_trades.trade_type)::text = 'sell'::text) THEN COALESCE(director_trades.total_value, (0)::numeric)
                    ELSE (0)::numeric
                END), (0)::numeric)) AS net_director_buy_value,
            count(*) FILTER (WHERE ((director_trades.trade_type)::text = 'buy'::text)) AS director_buy_count,
            count(*) FILTER (WHERE ((director_trades.trade_type)::text = 'sell'::text)) AS director_sell_count
           FROM director_trades
          WHERE (director_trades.trade_date >= (CURRENT_DATE - '90 days'::interval))
          GROUP BY director_trades.stock_code
        ), news_summary AS (
         SELECT news_articles.stock_code,
            count(*) AS news_count_30d,
            avg(
                CASE
                    WHEN ((news_articles.sentiment)::text = 'positive'::text) THEN 1.0
                    WHEN ((news_articles.sentiment)::text = 'negative'::text) THEN '-1.0'::numeric
                    ELSE 0.0
                END) AS avg_sentiment,
            count(*) FILTER (WHERE news_articles.is_price_sensitive) AS price_sensitive_count
           FROM news_articles
          WHERE (news_articles.published_at >= (CURRENT_TIMESTAMP - '30 days'::interval))
          GROUP BY news_articles.stock_code
        ), dividend_summary AS (
         SELECT dividend_history.stock_code,
            sum(dividend_history.amount_per_share) AS trailing_12m_dividend,
            avg(dividend_history.franking_percentage) AS avg_franking_pct
           FROM dividend_history
          WHERE (dividend_history.ex_date >= (CURRENT_DATE - '1 year'::interval))
          GROUP BY dividend_history.stock_code
        )
 SELECT ls.stock_code,
    ls.product_name,
    COALESCE(cm.company_name, ls.product_name) AS company_name,
    COALESCE(cm.industry, ''::text) AS industry,
    ls.short_pct,
    COALESCE(sc.short_pct_change_4w, (0)::double precision) AS short_pct_change_4w,
    COALESCE(lp.latest_price, (0)::numeric) AS latest_price,
    COALESCE(pc.price_change_1m, (0)::numeric) AS price_change_1m,
    COALESCE(lp.latest_volume, (0)::bigint) AS latest_volume,
    COALESCE(((cm.key_metrics ->> 'market_cap'::text))::double precision, (0)::double precision) AS market_cap,
    COALESCE(((cm.key_metrics ->> 'pe_ratio'::text))::double precision, (0)::double precision) AS pe_ratio,
    COALESCE(((cm.key_metrics ->> 'dividend_yield'::text))::double precision, (0)::double precision) AS dividend_yield,
    COALESCE(ds.net_director_buy_value, (0)::numeric) AS net_director_buy_value,
    COALESCE(ds.director_buy_count, (0)::bigint) AS director_buy_count,
    COALESCE(ds.director_sell_count, (0)::bigint) AS director_sell_count,
    COALESCE(ns.news_count_30d, (0)::bigint) AS news_count_30d,
    COALESCE(ns.avg_sentiment, (0)::numeric) AS avg_sentiment,
    COALESCE(ns.price_sensitive_count, (0)::bigint) AS price_sensitive_count,
    COALESCE(divs.trailing_12m_dividend, (0)::numeric) AS trailing_12m_dividend,
    COALESCE(divs.avg_franking_pct, (0)::numeric) AS avg_franking_pct,
    COALESCE(cm.logo_gcs_url, ''::text) AS logo_url,
    COALESCE(av.avg_volume_20d, (0)::bigint) AS avg_volume_20d,
        CASE
            WHEN (COALESCE(av.avg_volume_20d, (0)::bigint) > 0) THEN round(((ls.reported_short_positions / (av.avg_volume_20d)::double precision))::numeric, 2)
            ELSE (0)::numeric
        END AS days_to_cover
   FROM ((((((((latest_shorts ls
     LEFT JOIN "company-metadata" cm ON ((cm.stock_code = ls.stock_code)))
     LEFT JOIN short_change sc ON ((sc.stock_code = ls.stock_code)))
     LEFT JOIN latest_price lp ON (((lp.stock_code)::text = ls.stock_code)))
     LEFT JOIN avg_volume av ON (((av.stock_code)::text = ls.stock_code)))
     LEFT JOIN price_change pc ON (((pc.stock_code)::text = ls.stock_code)))
     LEFT JOIN director_summary ds ON (((ds.stock_code)::text = ls.stock_code)))
     LEFT JOIN news_summary ns ON (((ns.stock_code)::text = ls.stock_code)))
     LEFT JOIN dividend_summary divs ON (((divs.stock_code)::text = ls.stock_code)))
WITH DATA;

CREATE UNIQUE INDEX idx_mv_screener_data_stock_code ON public.mv_screener_data USING btree (stock_code);

CREATE INDEX idx_mv_screener_data_short_pct ON public.mv_screener_data USING btree (short_pct DESC);

CREATE INDEX idx_mv_screener_data_market_cap ON public.mv_screener_data USING btree (market_cap DESC);

CREATE INDEX idx_mv_screener_data_industry ON public.mv_screener_data USING btree (industry);

CREATE INDEX idx_mv_screener_data_days_to_cover ON public.mv_screener_data USING btree (days_to_cover DESC);

DROP MATERIALIZED VIEW IF EXISTS mv_top_shorts;

CREATE MATERIALIZED VIEW mv_top_shorts AS
WITH latest_date AS (
         SELECT max(shorts."DATE") AS max_date
           FROM shorts
        ), recent_shorts AS (
         SELECT DISTINCT ON (s."PRODUCT_CODE") s."PRODUCT_CODE",
            s."PRODUCT",
            s."DATE",
            s."PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" AS current_percent,
            s."REPORTED_SHORT_POSITIONS",
            s."TOTAL_PRODUCT_IN_ISSUE"
           FROM (shorts s
             CROSS JOIN latest_date ld)
          WHERE ((s."PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" > (0)::double precision) AND (s."DATE" > (ld.max_date - '1 mon'::interval)) AND (s."PRODUCT" !~~* '%DEFERRED SETTLEMENT%'::text) AND (s."PRODUCT" !~~* '%DEFERRED%'::text))
          ORDER BY s."PRODUCT_CODE", s."DATE" DESC
        )
 SELECT rs."PRODUCT_CODE" AS product_code,
    rs."PRODUCT" AS product_name,
    rs."DATE" AS latest_date,
    rs.current_percent,
    rs."REPORTED_SHORT_POSITIONS" AS reported_short_positions,
    rs."TOTAL_PRODUCT_IN_ISSUE" AS total_in_issue,
    cm.company_name,
    cm.industry,
    cm.logo_gcs_url,
    now() AS last_refreshed
   FROM (recent_shorts rs
     LEFT JOIN "company-metadata" cm ON ((rs."PRODUCT_CODE" = cm.stock_code)))
  ORDER BY rs.current_percent DESC
WITH DATA;

CREATE UNIQUE INDEX idx_mv_top_shorts_product ON public.mv_top_shorts USING btree (product_code);

CREATE INDEX idx_mv_top_shorts_percent ON public.mv_top_shorts USING btree (current_percent DESC);

CREATE INDEX idx_mv_top_shorts_industry ON public.mv_top_shorts USING btree (industry, current_percent DESC);

DROP MATERIALIZED VIEW IF EXISTS mv_watchlist_defaults;

CREATE MATERIALIZED VIEW mv_watchlist_defaults AS
WITH default_stocks AS (
         SELECT unnest(ARRAY['CBA'::text, 'BHP'::text, 'CSL'::text, 'WBC'::text, 'ANZ'::text, 'RIO'::text, 'WOW'::text, 'TLS'::text]) AS stock_code
        ), latest_prices AS (
         SELECT DISTINCT ON (sp.stock_code) sp.stock_code,
            sp.date AS price_date,
            sp.close AS latest_price,
            sp.open,
            sp.high,
            sp.low,
            sp.volume
           FROM (stock_prices sp
             JOIN default_stocks ds_1 ON (((sp.stock_code)::text = ds_1.stock_code)))
          ORDER BY sp.stock_code, sp.date DESC
        ), price_changes AS (
         SELECT lp.stock_code,
            lp.latest_price,
            lp.open,
            lp.high,
            lp.low,
            lp.volume,
            lp.price_date,
            prev.close AS previous_close,
                CASE
                    WHEN (prev.close > (0)::numeric) THEN (((lp.latest_price - prev.close) / prev.close) * (100)::numeric)
                    ELSE (0)::numeric
                END AS change_percent,
            (lp.latest_price - COALESCE(prev.close, lp.latest_price)) AS change_amount
           FROM (latest_prices lp
             LEFT JOIN LATERAL ( SELECT stock_prices.close
                   FROM stock_prices
                  WHERE (((stock_prices.stock_code)::text = (lp.stock_code)::text) AND (stock_prices.date < lp.price_date))
                  ORDER BY stock_prices.date DESC
                 LIMIT 1) prev ON (true))
        ), latest_shorts AS (
         SELECT DISTINCT ON (s."PRODUCT_CODE") s."PRODUCT_CODE" AS stock_code,
            s."DATE" AS shorts_date,
            s."PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" AS short_percent,
            s."REPORTED_SHORT_POSITIONS",
            s."TOTAL_PRODUCT_IN_ISSUE"
           FROM (shorts s
             JOIN default_stocks ds_1 ON ((s."PRODUCT_CODE" = ds_1.stock_code)))
          ORDER BY s."PRODUCT_CODE", s."DATE" DESC
        )
 SELECT ds.stock_code,
    cm.company_name,
    cm.industry,
    cm.logo_gcs_url,
    pc.latest_price,
    pc.open,
    pc.high,
    pc.low,
    pc.volume,
    pc.previous_close,
    pc.change_percent,
    pc.change_amount,
    pc.price_date,
    ls.short_percent,
    ls."REPORTED_SHORT_POSITIONS" AS reported_short_positions,
    ls."TOTAL_PRODUCT_IN_ISSUE" AS total_in_issue,
    ls.shorts_date,
    now() AS last_refreshed
   FROM (((default_stocks ds
     LEFT JOIN "company-metadata" cm ON ((ds.stock_code = cm.stock_code)))
     LEFT JOIN price_changes pc ON ((ds.stock_code = (pc.stock_code)::text)))
     LEFT JOIN latest_shorts ls ON ((ds.stock_code = ls.stock_code)))
WITH DATA;

CREATE UNIQUE INDEX idx_mv_watchlist_defaults_stock ON public.mv_watchlist_defaults USING btree (stock_code);

DROP MATERIALIZED VIEW IF EXISTS mv_short_campaigns;

CREATE MATERIALIZED VIEW mv_short_campaigns AS
WITH ranked AS (
         SELECT shorts."PRODUCT_CODE" AS stock_code,
            (shorts."DATE")::date AS peak_date,
            shorts."PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" AS peak_short_pct,
            row_number() OVER (PARTITION BY shorts."PRODUCT_CODE" ORDER BY shorts."PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" DESC, shorts."DATE" DESC) AS rn
           FROM shorts
          WHERE ((shorts."DATE" >= (now() - '3 years'::interval)) AND (shorts."PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" IS NOT NULL))
        ), peaks AS (
         SELECT ranked.stock_code,
            ranked.peak_date,
            ranked.peak_short_pct
           FROM ranked
          WHERE ((ranked.rn = 1) AND (ranked.peak_short_pct >= (5.0)::double precision))
        )
 SELECT p.stock_code,
    p.peak_date,
    p.peak_short_pct,
    pk.close AS price_at_peak,
    p3.close AS price_3m_after,
    p6.close AS price_6m_after,
    (round((((p3.close - pk.close) / NULLIF(pk.close, (0)::numeric)) * (100)::numeric), 2))::double precision AS return_3m,
    (round((((p6.close - pk.close) / NULLIF(pk.close, (0)::numeric)) * (100)::numeric), 2))::double precision AS return_6m,
        CASE
            WHEN ((p3.close IS NULL) OR (pk.close IS NULL) OR (pk.close = (0)::numeric)) THEN NULL::boolean
            ELSE (p3.close < pk.close)
        END AS shorts_won_3m,
        CASE
            WHEN ((p6.close IS NULL) OR (pk.close IS NULL) OR (pk.close = (0)::numeric)) THEN NULL::boolean
            ELSE (p6.close < pk.close)
        END AS shorts_won_6m,
    cur.current_short_pct,
    lp.close AS latest_price,
    COALESCE(cm.company_name, ''::text) AS company_name,
    COALESCE(cm.industry, ''::text) AS industry,
    COALESCE(cm.logo_gcs_url, ''::text) AS logo_url
   FROM ((((((peaks p
     LEFT JOIN LATERAL ( SELECT sp.close
           FROM stock_prices sp
          WHERE (((sp.stock_code)::text = p.stock_code) AND (sp.date <= p.peak_date))
          ORDER BY sp.date DESC
         LIMIT 1) pk ON (true))
     LEFT JOIN LATERAL ( SELECT sp.close
           FROM stock_prices sp
          WHERE (((sp.stock_code)::text = p.stock_code) AND (sp.date >= (p.peak_date + '3 mons'::interval)))
          ORDER BY sp.date
         LIMIT 1) p3 ON (true))
     LEFT JOIN LATERAL ( SELECT sp.close
           FROM stock_prices sp
          WHERE (((sp.stock_code)::text = p.stock_code) AND (sp.date >= (p.peak_date + '6 mons'::interval)))
          ORDER BY sp.date
         LIMIT 1) p6 ON (true))
     LEFT JOIN LATERAL ( SELECT s."PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" AS current_short_pct
           FROM shorts s
          WHERE (s."PRODUCT_CODE" = p.stock_code)
          ORDER BY s."DATE" DESC
         LIMIT 1) cur ON (true))
     LEFT JOIN LATERAL ( SELECT sp.close
           FROM stock_prices sp
          WHERE ((sp.stock_code)::text = p.stock_code)
          ORDER BY sp.date DESC
         LIMIT 1) lp ON (true))
     LEFT JOIN "company-metadata" cm ON ((cm.stock_code = p.stock_code)))
WITH DATA;

CREATE UNIQUE INDEX idx_mv_short_campaigns_stock_code ON public.mv_short_campaigns USING btree (stock_code);

CREATE INDEX idx_mv_short_campaigns_peak_pct ON public.mv_short_campaigns USING btree (peak_short_pct DESC);

CREATE INDEX idx_mv_short_campaigns_industry ON public.mv_short_campaigns USING btree (industry);
