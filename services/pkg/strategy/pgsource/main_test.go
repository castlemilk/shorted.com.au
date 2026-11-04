package pgsource

import (
	"os"
	"testing"

	"github.com/castlemilk/shorted.com.au/services/pkg/testpostgres"
)

// TestMain removes the container the reader suite starts under
// PGSOURCE_TESTCONTAINERS=1. It starts nothing itself.
func TestMain(m *testing.M) {
	os.Exit(testpostgres.Main(m))
}
