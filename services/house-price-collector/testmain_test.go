package main

import (
	"os"
	"strings"
	"testing"

	"github.com/castlemilk/shorted.com.au/services/pkg/testpostgres"
)

// TestMain removes the testcontainers Postgres that the DB tests may start. Without
// HOUSING_TESTCONTAINERS=1 and the testcontainers build tag, it does nothing. As in
// pkg/housingcrawl and shorts/internal/ingest, a CI run never leaks a container.
//
// HPC_CHILD_RUN=1 turns the test binary into the collector itself: the subprocess tests
// (crawl_review_test.go) re-exec it with HPC_CHILD_ARGS, so they exercise the real main
// path, its flag parsing and its exit codes.
func TestMain(m *testing.M) {
	// CYCLE_FAKE_CHILD_DIR turns the test binary into the fake -mode agent child the cycle tests
	// spawn (crawl_cycle_fake_test.go). It runs before the test suite, so the child is never a test run.
	if dir := os.Getenv(cycleFakeChildEnv); dir != "" {
		os.Exit(runCycleFakeChild(dir))
	}
	if os.Getenv("HPC_CHILD_RUN") == "1" {
		os.Args = append([]string{"house-price-collector"}, strings.Fields(os.Getenv("HPC_CHILD_ARGS"))...)
		os.Exit(run())
	}
	os.Exit(testpostgres.Main(m))
}
