package main

import (
	"errors"
	"fmt"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
)

func TestIsPermanentRowError(t *testing.T) {
	// Class 22 (data exception) + 23 (integrity constraint) are PERMANENT per-row
	// errors that recur identically every crawl → skip the one listing, keep the
	// suburb (diffSuburb's per-row SAVEPOINT).
	permanent := []string{
		"22021", // invalid_byte_sequence_for_encoding (the NUL / bad-UTF8 case)
		"22003", // numeric_value_out_of_range
		"22007", // invalid_datetime_format
		"23502", // not_null_violation
		"23514", // check_violation
		"23503", // foreign_key_violation
		"23505", // unique_violation (if one ever escapes an ON CONFLICT)
	}
	for _, code := range permanent {
		if !isPermanentRowError(&pgconn.PgError{Code: code}) {
			t.Errorf("SQLSTATE %s should be PERMANENT (skip the row, keep the suburb)", code)
		}
	}

	// Everything else is TRANSIENT → propagate so the suburb fails + requeues
	// rather than silently dropping data on a blip.
	transient := []string{
		"08006", // connection_failure
		"08003", // connection_does_not_exist
		"40001", // serialization_failure
		"40P01", // deadlock_detected
		"53300", // too_many_connections
		"57014", // query_canceled
		"57P01", // admin_shutdown
	}
	for _, code := range transient {
		if isPermanentRowError(&pgconn.PgError{Code: code}) {
			t.Errorf("SQLSTATE %s should be TRANSIENT (propagate, don't skip)", code)
		}
	}

	// A non-Postgres error (network/driver) is transient; nil is not permanent.
	if isPermanentRowError(errors.New("dial tcp 1.2.3.4:5432: connect: connection refused")) {
		t.Error("a network error must be treated as transient")
	}
	if isPermanentRowError(nil) {
		t.Error("nil must not be a permanent row error")
	}
	// A WRAPPED PgError is still classified (errors.As unwraps).
	if !isPermanentRowError(fmt.Errorf("upsertListing: %w", &pgconn.PgError{Code: "22021"})) {
		t.Error("a wrapped class-22 error should still be permanent")
	}
	// A malformed short SQLSTATE must not panic and is treated as transient (safe).
	if isPermanentRowError(&pgconn.PgError{Code: "2"}) {
		t.Error("a malformed short SQLSTATE should be transient (fail safe)")
	}
}
