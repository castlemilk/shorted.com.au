-- Put the headline parser's rows back. A notice row now holding the same
-- (stock_code, ex_date, dividend_type) wins.
INSERT INTO dividend_history (id, stock_code, ex_date, payment_date, amount_per_share,
                              franking_percentage, dividend_type, created_at)
SELECT id, stock_code, ex_date, payment_date, amount_per_share,
       franking_percentage, dividend_type, created_at
FROM dividend_history_headline_rows
ON CONFLICT DO NOTHING;

DROP TABLE IF EXISTS dividend_history_headline_rows;
