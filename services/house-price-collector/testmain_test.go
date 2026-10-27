package main

import (
	"os"
	"testing"

	"github.com/castlemilk/shorted.com.au/services/pkg/testpostgres"
)

// TestMain removes the testcontainers Postgres that the DB tests may start. Without
// HOUSING_TESTCONTAINERS=1 and the testcontainers build tag, it does nothing. As in
// pkg/housingcrawl and shorts/internal/ingest, a CI run never leaks a container.
func TestMain(m *testing.M) { os.Exit(testpostgres.Main(m)) }
