-- Read-only spot check of the strategy daily snapshot (services/jobs/internal/jobs/strategies).
--
-- Run after the 13:30 UTC picks refresh, which refreshes mv_price_features and mv_market_regime:
--   task db:prod:psql -- -P pager=off -f scripts/strategy-daily-spot-check.sql
--
-- For three codes on the newest completed session, every key of the stored fs1 features
-- must equal the same column of mv_price_features, and the stored XJO regime row must equal
-- mv_market_regime. Numbers compare within 1e-6 relative. Every result row should read
-- 'equal'. A 'mismatch' is a finding: the snapshot and the view disagree on that session.
-- The views are as of their newest bar, so view_as_of must equal the session for the
-- comparison to mean anything; a later view_as_of is reported, not compared away.
-- Section 4 checks the signal events the session wrote: each non-exit event's evidence r
-- holds one P, F or U per rule of its version, and v and p hold one entry per rule. Its
-- results read 'ok' or 'mismatch'; a mismatch means the event credits outcomes to the wrong rules.

-- 1. The session compared, and the view dates it is compared against.
WITH s AS (
  SELECT max(as_of) AS session
    FROM strategy_daily_runs
   WHERE phase = 'features' AND status = 'completed'
)
SELECT s.session,
       (SELECT max(as_of) FROM mv_price_features)  AS price_view_as_of,
       (SELECT max(as_of) FROM mv_market_regime)   AS regime_view_as_of,
       (SELECT count(*) FROM strategy_features_daily f, s
         WHERE f.as_of = s.session AND f.feature_set = 'fs1'
           AND f.stock_code IN ('BHP', 'CBA', 'CSL')) AS stored_codes_compared
  FROM s;

-- 2. The stored fs1 features against mv_price_features, key by key.
WITH s AS (
  SELECT max(as_of) AS session
    FROM strategy_daily_runs
   WHERE phase = 'features' AND status = 'completed'
), stored AS (
  SELECT f.stock_code, kv.key, kv.value AS stored
    FROM strategy_features_daily f
    CROSS JOIN s
    CROSS JOIN LATERAL jsonb_each_text(f.features -> 'fs1') kv
   WHERE f.as_of = s.session AND f.feature_set = 'fs1'
     AND f.stock_code IN ('BHP', 'CBA', 'CSL')
), viewed AS (
  SELECT p.stock_code, kv.key, kv.value AS viewed
    FROM mv_price_features p
    CROSS JOIN LATERAL jsonb_each_text(to_jsonb(p)) kv
   WHERE p.stock_code IN ('BHP', 'CBA', 'CSL')
), compared AS (
  SELECT st.stock_code, st.key, st.stored, vw.viewed,
         CASE
           WHEN st.stored IS NULL AND vw.viewed IS NULL THEN 'equal'
           WHEN st.stored IS NULL OR vw.viewed IS NULL THEN 'mismatch'
           WHEN st.stored ~ '^-?[0-9]+(\.[0-9]+)?([eE][-+]?[0-9]+)?$'
            AND vw.viewed ~ '^-?[0-9]+(\.[0-9]+)?([eE][-+]?[0-9]+)?$'
           THEN CASE WHEN abs(st.stored::float8 - vw.viewed::float8)
                          <= 1e-6 * greatest(1, abs(vw.viewed::float8))
                     THEN 'equal' ELSE 'mismatch' END
           WHEN st.stored = vw.viewed THEN 'equal'
           ELSE 'mismatch'
         END AS result
    FROM stored st
    JOIN viewed vw ON vw.stock_code = st.stock_code AND vw.key = st.key
)
SELECT 'fs1' AS scope, stock_code AS subject, key, stored, viewed, result
  FROM compared
 ORDER BY result DESC, stock_code, key;

-- 3. The stored XJO regime against mv_market_regime, column by column.
WITH s AS (
  SELECT max(as_of) AS session
    FROM strategy_daily_runs
   WHERE phase = 'features' AND status = 'completed'
), stored AS (
  SELECT kv.key, kv.value AS stored
    FROM strategy_regime_daily r
    CROSS JOIN s
    CROSS JOIN LATERAL jsonb_each_text(to_jsonb(r)) kv
   WHERE r.as_of = s.session AND r.index_code = 'XJO'
     AND kv.key NOT IN ('as_of', 'index_code')
), viewed AS (
  SELECT kv.key, kv.value AS viewed
    FROM mv_market_regime m
    CROSS JOIN LATERAL jsonb_each_text(to_jsonb(m)) kv
   WHERE m.index_code = 'XJO'
     AND kv.key NOT IN ('as_of', 'index_code')
)
SELECT 'regime' AS scope, 'XJO' AS subject, st.key, st.stored, vw.viewed,
       CASE
         WHEN st.stored IS NULL AND vw.viewed IS NULL THEN 'equal'
         WHEN st.stored IS NULL OR vw.viewed IS NULL THEN 'mismatch'
         WHEN st.stored ~ '^-?[0-9]+(\.[0-9]+)?([eE][-+]?[0-9]+)?$'
          AND vw.viewed ~ '^-?[0-9]+(\.[0-9]+)?([eE][-+]?[0-9]+)?$'
         THEN CASE WHEN abs(st.stored::float8 - vw.viewed::float8)
                        <= 1e-6 * greatest(1, abs(vw.viewed::float8))
                   THEN 'equal' ELSE 'mismatch' END
         WHEN st.stored = vw.viewed THEN 'equal'
         ELSE 'mismatch'
       END AS result
  FROM stored st
  JOIN viewed vw ON vw.key = st.key
 ORDER BY result DESC, st.key;

-- 4. The signal events on the session: r, v and p against the rule count of the event's version.
WITH s AS (
  SELECT max(as_of) AS session
    FROM strategy_daily_runs
   WHERE phase = 'features' AND status = 'completed'
)
SELECT e.stock_code, e.rules_hash, e.to_status, e.evidence->>'r' AS r,
       jsonb_array_length(v.canonical_json -> 'rules') AS version_rules,
       CASE
         WHEN e.evidence->>'r' ~ '^[PFU]*$'
          AND length(e.evidence->>'r') = jsonb_array_length(v.canonical_json -> 'rules')
          AND jsonb_array_length(e.evidence -> 'v') = jsonb_array_length(v.canonical_json -> 'rules')
          AND jsonb_array_length(e.evidence -> 'p') = jsonb_array_length(v.canonical_json -> 'rules')
         THEN 'ok' ELSE 'mismatch'
       END AS result
  FROM strategy_signal_events e
  CROSS JOIN s
  JOIN strategy_rule_versions v ON v.rules_hash = e.rules_hash
 WHERE e.as_of = s.session AND e.to_status <> 'none'
 ORDER BY result DESC, e.stock_code;
