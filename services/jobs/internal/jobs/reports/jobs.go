package reports

import "github.com/castlemilk/shorted.com.au/services/jobs/internal/runner"

// Group returns the `shorted reports <coverage|link|sync>` job family.
func Group() runner.Job {
	return runner.NewGroup(
		"reports",
		"financial-report coverage, link extraction and GCS sync",
		CoverageJob(),
		LinkJob(),
		SyncJob(),
	)
}
