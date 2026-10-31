package main

import (
	"log"
	"os"
	"path/filepath"
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
	// The parent-death tests run three processes: a runtime stand-in (CYCLE_TEST_RUNTIME), the cycle it
	// spawns (CYCLE_TEST_CYCLE), and the cycle's fake child. Checked first, so the fake child never
	// inherits a parent role (crawl_cycle_parent_test.go).
	if os.Getenv(cycleTestCycleEnv) == "1" {
		os.Exit(runCycleTestCycle())
	}
	if os.Getenv(cycleTestRuntimeEnv) == "1" {
		os.Exit(runCycleTestRuntime())
	}
	// CYCLE_TEST_AGENT runs one -mode agent process with no BrandBrain config, so the ready-first test
	// can read its events from a pipe it owns (crawl_cycle_test.go).
	if os.Getenv(cycleTestAgentEnv) == "1" {
		os.Exit(runCycleTestAgent())
	}
	// CYCLE_TEST_INSTALL_CMD runs the real -mode install-driver body once (crawl_driver_install_test.go).
	if os.Getenv("CYCLE_TEST_INSTALL_CMD") == "1" {
		os.Exit(runInstallDriver(false))
	}
	// CYCLE_TEST_INSTALL runs one atomic driver install that stalls mid-write (crawl_driver_atomic_test.go).
	if os.Getenv("CYCLE_TEST_INSTALL") == "1" {
		os.Exit(runDriverInstallChild())
	}
	// CYCLE_FAKE_CHILD_DIR turns the test binary into the fake -mode agent child the cycle tests
	// spawn (crawl_cycle_fake_test.go). It runs before the test suite, so the child is never a test run.
	if dir := os.Getenv(cycleFakeChildEnv); dir != "" {
		os.Exit(runCycleFakeChild(dir))
	}
	if os.Getenv("HPC_CHILD_RUN") == "1" {
		os.Args = append([]string{"house-price-collector"}, strings.Fields(os.Getenv("HPC_CHILD_ARGS"))...)
		os.Exit(run())
	}
	// The circuit state defaults under the real home. Every test run gets a scratch file, so no test
	// writes ~/.shorted-housing-crawl; a test that needs its own file sets it with t.Setenv.
	scratch, err := os.MkdirTemp("", "hpc-circuit-state-")
	if err != nil {
		log.Fatalf("circuit state scratch dir: %v", err)
	}
	_ = os.Setenv(circuitStateEnv, filepath.Join(scratch, "circuit-state.json"))
	// The crawl lock defaults under the real home too, so a test run and a live housing
	// crawl on the same Mac contend for one lock: the test then exits 12 ("another housing
	// crawl is draining") or, worse, holds the real lock while the rig is working. Every
	// test process gets its own lock dir, and child processes inherit it.
	// Only when unset: the test binary also runs as the child of a bash lock test, which hands
	// it the lock dir it must contend for, and that value must survive into the child.
	if os.Getenv(crawlLockDirEnv) == "" {
		_ = os.Setenv(crawlLockDirEnv, filepath.Join(scratch, "crawl.lockdir"))
	}
	code := testpostgres.Main(m)
	_ = os.RemoveAll(scratch)
	os.Exit(code)
}
