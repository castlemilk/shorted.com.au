-- 000050_director_trades_dedup (down)
-- Deleted duplicate rows cannot be restored; this only drops the constraint.

DROP INDEX IF EXISTS uq_director_trades_natural;
