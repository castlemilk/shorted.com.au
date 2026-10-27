package housingcrawl

import (
	"os"
	"testing"

	"github.com/castlemilk/shorted.com.au/services/pkg/testpostgres"
)

// TestMain removes the testcontainers Postgres that the DB tests may start. Without
// HOUSING_TESTCONTAINERS=1 and the testcontainers build tag, it does nothing.
func TestMain(m *testing.M) { os.Exit(testpostgres.Main(m)) }
