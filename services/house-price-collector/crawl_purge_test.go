package main

import (
	"encoding/json"
	"strings"
	"testing"
)

// TestCrawlPurgeRequestJSON guards the wire contract between the collector's
// -mode purge request and brandbrain's crawlJobPurgeRequest handler fields.
func TestCrawlPurgeRequestJSON(t *testing.T) {
	b, err := json.Marshal(crawlPurgeRequest{
		Source:   "both",
		Statuses: []string{"pending", "in_progress"},
		DryRun:   false,
	})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	s := string(b)
	for _, want := range []string{`"source":"both"`, `"statuses":["pending","in_progress"]`, `"dry_run":false`} {
		if !strings.Contains(s, want) {
			t.Errorf("purge request JSON missing %s\n got: %s", want, s)
		}
	}
	// kind/tier are omitempty — absent when unset.
	if strings.Contains(s, `"kind"`) || strings.Contains(s, `"tier"`) {
		t.Errorf("unset kind/tier should be omitted: %s", s)
	}
}
