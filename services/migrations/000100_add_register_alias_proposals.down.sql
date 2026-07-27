-- Dropping proposals loses no published data: nothing reads this table but the
-- review tooling, and a CONFIRMED proposal has already been copied into
-- register_security_aliases, which survives.
DROP TABLE IF EXISTS register_alias_proposals;
