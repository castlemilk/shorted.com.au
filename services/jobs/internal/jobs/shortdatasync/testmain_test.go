package shortdatasync

import (
	"os"
	"testing"

	"github.com/castlemilk/shorted.com.au/services/pkg/testpostgres"
)

// TestMain removes the container the strategy capture suite starts under
// SHORTDATASYNC_TESTCONTAINERS=1. It starts nothing itself.
func TestMain(m *testing.M) {
	os.Exit(testpostgres.Main(m))
}
