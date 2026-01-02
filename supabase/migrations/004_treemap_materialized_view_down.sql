-- Rollback Migration: Treemap Materialized View
-- This file removes the materialized view and related objects

-- Drop the helper function
DROP FUNCTION IF EXISTS get_treemap_data(TEXT, INT, TEXT);

-- Drop the refresh function
DROP FUNCTION IF EXISTS refresh_treemap_data();

-- Drop the materialized view (CASCADE will drop indexes automatically)
DROP MATERIALIZED VIEW IF EXISTS mv_treemap_data CASCADE;

-- Log rollback completion
DO $$
BEGIN
    RAISE NOTICE '==============================================';
    RAISE NOTICE 'Rollback 004: Treemap Materialized View';
    RAISE NOTICE '==============================================';
    RAISE NOTICE 'Removed: mv_treemap_data and all indexes';
    RAISE NOTICE 'Removed: refresh_treemap_data() function';
    RAISE NOTICE 'Removed: get_treemap_data() function';
    RAISE NOTICE '==============================================';
    RAISE NOTICE 'Note: Treemap queries will revert to original';
    RAISE NOTICE 'performance (11 seconds instead of 1.3ms)';
    RAISE NOTICE '==============================================';
END $$;

