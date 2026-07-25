-- Remove only the seeded aliases, identified by curated_by='seed'.
--
-- Deleting the whole table would destroy any curation a human added afterwards,
-- which is the entire value of the table.

DELETE FROM register_security_aliases WHERE curated_by = 'seed';
