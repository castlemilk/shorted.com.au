-- Remove the old headline parser's dividend rows (announcement_url NULL).
--
-- That parser (parser_dividend.go, deleted with 000133's release) read the
-- amount from an announcement's headline and used the announcement's date as
-- the ex-date. Of its 91 rows in prod on 2026-10-11, 18 carry the day they
-- were written as their ex-date, 14 read cents as dollars (VMC 35.0, BCN
-- 30.4), and FML's and RPL's duplicate a notice row a few days later, which
-- mv_screener_data.trailing_12m_dividend counts twice. The API has not served
-- them since 000133 (GetDividendHistory reads announcement_url IS NOT NULL);
-- the dividend notice pass fills in the real dividends from the notices.
--
-- Hand-applied, not allowlisted: it deletes rows. The rows are kept in
-- dividend_history_headline_rows, and the down migration puts them back.
-- Re-running deletes only rows that are in that backup.
CREATE TABLE IF NOT EXISTS dividend_history_headline_rows AS
SELECT * FROM dividend_history WHERE announcement_url IS NULL;

DELETE FROM dividend_history d
WHERE d.announcement_url IS NULL
  AND EXISTS (SELECT 1 FROM dividend_history_headline_rows b WHERE b.id = d.id);
