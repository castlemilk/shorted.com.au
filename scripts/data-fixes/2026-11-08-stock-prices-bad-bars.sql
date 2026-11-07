-- One-off data correction, 2026-11-08: delete 51 stock_prices bars that are not the ASX
-- listing's prices. Each row is matched on code, date AND its current close, so a row that
-- has changed since the review is left alone and the count check below aborts the whole
-- transaction (task db:prod:apply runs this file in one transaction).
--
--   SLM x3   2025-11-25/26 (~29.0) and 2025-12-24 (27.66): NASDAQ SLM Corp's bars under
--            ASX:SLM (~0.04-0.10); Yahoo has no ASX bar for 2025-12-24.
--   ENX x37  0.01-0.02 on the last session before each market closure (34 Fridays, the day
--            before Good Friday, 24 and 31 Dec 2024), 2023-11-03 to 2025-04-04, against a
--            local level of 0.06-0.12: a writer artefact (the April 2020 0.02 run is a real
--            carried price and is kept).
--   HRZ x4   0.04 inside a 0.54-0.60 series (unadjusted fragments).
--   BMO x1   0.01 with no volume between 0.28 and 0.31.
--   IVV, IJH x2, IJP, BBUS x2: one-day bars off by the unit split ratio (zero or near-zero
--            volume), in the vendor's own history.
-- Kept and reported instead: GLA/HCD/HTG/LNU first-of-month high-volume days (inside the
-- local range), EQS 2024-06-14 (a 5-share print), NTM 2026-05/06 and KLR 2025-08 (no source
-- to decide), and the close = 0 rows.
-- The backup of every row is in the PR thread (#934). The guard against new collisions is #934.
DO $$
DECLARE n int;
BEGIN
  DELETE FROM stock_prices sp
   USING (VALUES
    ('ENX', DATE '2023-11-03', 0.0200::numeric),
    ('ENX', DATE '2023-11-10', 0.0200::numeric),
    ('ENX', DATE '2023-11-17', 0.0200::numeric),
    ('ENX', DATE '2023-11-24', 0.0200::numeric),
    ('ENX', DATE '2024-02-09', 0.0200::numeric),
    ('ENX', DATE '2024-02-16', 0.0200::numeric),
    ('ENX', DATE '2024-02-23', 0.0200::numeric),
    ('ENX', DATE '2024-03-08', 0.0200::numeric),
    ('ENX', DATE '2024-03-15', 0.0200::numeric),
    ('ENX', DATE '2024-03-28', 0.0200::numeric),
    ('ENX', DATE '2024-10-11', 0.0200::numeric),
    ('ENX', DATE '2024-10-18', 0.0200::numeric),
    ('ENX', DATE '2024-10-25', 0.0200::numeric),
    ('ENX', DATE '2024-11-08', 0.0100::numeric),
    ('ENX', DATE '2024-11-15', 0.0100::numeric),
    ('ENX', DATE '2024-11-22', 0.0100::numeric),
    ('ENX', DATE '2024-11-29', 0.0100::numeric),
    ('ENX', DATE '2024-12-06', 0.0100::numeric),
    ('ENX', DATE '2024-12-13', 0.0100::numeric),
    ('ENX', DATE '2024-12-20', 0.0100::numeric),
    ('ENX', DATE '2024-12-24', 0.0100::numeric),
    ('ENX', DATE '2024-12-27', 0.0100::numeric),
    ('ENX', DATE '2024-12-31', 0.0100::numeric),
    ('ENX', DATE '2025-01-03', 0.0100::numeric),
    ('ENX', DATE '2025-01-10', 0.0100::numeric),
    ('ENX', DATE '2025-01-17', 0.0100::numeric),
    ('ENX', DATE '2025-01-24', 0.0100::numeric),
    ('ENX', DATE '2025-01-31', 0.0100::numeric),
    ('ENX', DATE '2025-02-07', 0.0100::numeric),
    ('ENX', DATE '2025-02-14', 0.0100::numeric),
    ('ENX', DATE '2025-02-21', 0.0100::numeric),
    ('ENX', DATE '2025-02-28', 0.0100::numeric),
    ('ENX', DATE '2025-03-07', 0.0100::numeric),
    ('ENX', DATE '2025-03-14', 0.0100::numeric),
    ('ENX', DATE '2025-03-21', 0.0100::numeric),
    ('ENX', DATE '2025-03-28', 0.0100::numeric),
    ('ENX', DATE '2025-04-04', 0.0100::numeric),
    ('SLM', DATE '2025-11-25', 29.0300::numeric),
    ('SLM', DATE '2025-11-26', 29.0500::numeric),
    ('SLM', DATE '2025-12-24', 27.6600::numeric),
    ('HRZ', DATE '2024-01-05', 0.0400::numeric),
    ('HRZ', DATE '2024-01-08', 0.0400::numeric),
    ('HRZ', DATE '2024-12-24', 0.0400::numeric),
    ('HRZ', DATE '2024-12-27', 0.0400::numeric),
    ('BMO', DATE '2024-02-16', 0.0100::numeric),
    ('IVV', DATE '2015-12-28', 284.1798::numeric),
    ('IJH', DATE '2015-12-28', 193.9692::numeric),
    ('IJH', DATE '2016-08-04', 202.5975::numeric),
    ('IJP', DATE '2016-11-04', 256.8000::numeric),
    ('BBUS', DATE '2016-09-19', 10.0044::numeric),
    ('BBUS', DATE '2016-12-20', 8.3666::numeric)
   ) AS v(code, d, c)
   WHERE sp.stock_code = v.code AND sp.date = v.d AND sp.close = v.c;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 51 THEN
    RAISE EXCEPTION 'expected to delete 51 rows, matched %: refusing', n;
  END IF;
END $$;
