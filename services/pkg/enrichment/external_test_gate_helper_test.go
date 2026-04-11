package enrichment

import (
	"os"
	"strings"
	"testing"
)

func externalEnrichmentTestsEnabled() bool {
	return strings.TrimSpace(os.Getenv("RUN_ENRICHMENT_INTEGRATION_TESTS")) == "1"
}

func requireExternalEnrichmentTests(t *testing.T, description string) {
	t.Helper()

	if testing.Short() {
		t.Skip("skipping external enrichment tests in short mode")
	}

	if !externalEnrichmentTestsEnabled() {
		t.Skipf("set RUN_ENRICHMENT_INTEGRATION_TESTS=1 to run %s", description)
	}
}
