-- Intentionally preserve production-owned asset URLs on rollback. The copied
-- objects are permanent production data; repointing rows at the retired
-- development project would reintroduce the dependency this migration removes.
SELECT 1;
