-- Per-suburb listing-price aggregates derived from crawled portal listings:
-- average/median ASKING price (active for-sale) and SOLD price (recent sales).
-- Derived aggregate only — the raw listings stay proprietary-tos-restricted.

CREATE MATERIALIZED VIEW IF NOT EXISTS mv_suburb_listing_stats AS
WITH fs AS (  -- active for-sale (asking prices)
    SELECT region_code,
        COUNT(*)                                        AS for_sale_count,
        COUNT(price)                                    AS for_sale_priced,
        AVG(price)                                      AS avg_asking,
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY price)
            FILTER (WHERE price IS NOT NULL)            AS median_asking
    FROM property_listings
    WHERE is_active AND listing_status IN ('for_sale', 'under_offer')
    GROUP BY region_code
), sold AS (  -- recent sales (sold prices)
    SELECT region_code,
        COUNT(*)                                        AS sold_count,
        AVG(price)                                      AS avg_sold,
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY price) AS median_sold
    FROM property_listings
    WHERE listing_status = 'sold' AND price IS NOT NULL
    GROUP BY region_code
)
SELECT COALESCE(fs.region_code, sold.region_code)       AS region_code,
       COALESCE(fs.for_sale_count, 0)                   AS for_sale_count,
       COALESCE(fs.for_sale_priced, 0)                  AS for_sale_priced,
       fs.avg_asking, fs.median_asking,
       COALESCE(sold.sold_count, 0)                     AS sold_count,
       sold.avg_sold, sold.median_sold
FROM fs
FULL OUTER JOIN sold USING (region_code);

CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_suburb_listing_stats_key
    ON mv_suburb_listing_stats (region_code);

-- Fold the stats MV into the shared housing refresh (guarded fallback like 000076).
CREATE OR REPLACE FUNCTION refresh_housing_materialized_views()
RETURNS void AS $$
BEGIN
    REFRESH MATERIALIZED VIEW CONCURRENTLY mv_housing_headline;
    BEGIN
        REFRESH MATERIALIZED VIEW CONCURRENTLY mv_suburb_price_drops;
    EXCEPTION WHEN OTHERS THEN
        REFRESH MATERIALIZED VIEW mv_suburb_price_drops;
    END;
    BEGIN
        REFRESH MATERIALIZED VIEW CONCURRENTLY mv_suburb_listing_stats;
    EXCEPTION WHEN OTHERS THEN
        REFRESH MATERIALIZED VIEW mv_suburb_listing_stats;
    END;
END;
$$ LANGUAGE plpgsql;
