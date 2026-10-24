//go:build integration

package shorts

import (
	"os"
	"testing"

	"github.com/castlemilk/shorted.com.au/services/pkg/testpostgres"
)

// TestMain removes the container the alert store tests start under
// ALERTS_E2E_TESTCONTAINERS=1. It starts nothing itself.
func TestMain(m *testing.M) {
	os.Exit(testpostgres.Main(m))
}
