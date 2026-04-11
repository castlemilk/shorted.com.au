package enrichment

import "testing"

func TestExternalEnrichmentTestsEnabled(t *testing.T) {
	t.Run("disabled by default", func(t *testing.T) {
		t.Setenv("RUN_ENRICHMENT_INTEGRATION_TESTS", "")

		if externalEnrichmentTestsEnabled() {
			t.Fatal("expected external enrichment tests to be disabled by default")
		}
	})

	t.Run("enabled explicitly", func(t *testing.T) {
		t.Setenv("RUN_ENRICHMENT_INTEGRATION_TESTS", "1")

		if !externalEnrichmentTestsEnabled() {
			t.Fatal("expected external enrichment tests to be enabled when opt-in env is set")
		}
	})
}
