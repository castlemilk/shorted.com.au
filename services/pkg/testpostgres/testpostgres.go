// Package testpostgres gives the alerts end-to-end suites a disposable PostgreSQL
// server. A server named by an environment variable is used as is: that is the
// local path, and the suite creates and drops its own databases or schemas on it.
// Otherwise the suite starts a postgres container through testcontainers, the
// mechanism test-integration-ci uses. A container is needed on the CI runners:
// their Docker daemon is the host's, so a port published on 127.0.0.1 inside the
// runner is not the port the daemon published.
//
// testcontainers is built only with the testcontainers tag. Its gopsutil
// dependency crashes a macOS test binary at init when cgo is on, so a plain
// go test of the suites must not link it.
package testpostgres

import (
	"os"
	"testing"
)

// Admin returns a DSN for a disposable server, or "" when the suite should skip.
// The URL in urlEnv wins when set. Otherwise, when optInEnv is "1", one container
// serves the whole test binary and Main removes it. The DSN targets the "postgres"
// database, so callers create their own databases or schemas.
func Admin(urlEnv, optInEnv string) (string, error) {
	if url := os.Getenv(urlEnv); url != "" {
		return url, nil
	}
	if os.Getenv(optInEnv) != "1" {
		return "", nil
	}
	return startContainer()
}

// Main is the TestMain body for a package that calls Admin. It runs the tests,
// then removes the container Admin started, if any, so no container outlives
// the test binary.
//
//	func TestMain(m *testing.M) { os.Exit(testpostgres.Main(m)) }
func Main(m *testing.M) int {
	code := m.Run()
	terminateContainer()
	return code
}
