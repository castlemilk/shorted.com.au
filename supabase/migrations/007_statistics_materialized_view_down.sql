-- Migration: Statistics Materialized View (DOWN)
-- Purpose: Rollback the about statistics materialized view

-- Drop functions first
DROP FUNCTION IF EXISTS get_about_statistics();
DROP FUNCTION IF EXISTS refresh_about_statistics();

-- Drop the materialized view
DROP MATERIALIZED VIEW IF EXISTS mv_about_statistics CASCADE;

RAISE NOTICE 'Rolled back migration 007: About Statistics Materialized View';

