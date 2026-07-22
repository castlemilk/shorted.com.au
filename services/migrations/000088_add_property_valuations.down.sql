-- Revert 000088: drop the address-seeded valuation table (its index goes with it).
DROP TABLE IF EXISTS property_valuations;
