package main

import (
	"reflect"
	"testing"
)

func TestScheduledOfficialJobsExcludeResidentialOnlyNSW(t *testing.T) {
	var names []string
	for _, job := range scheduledOfficialJobs() {
		names = append(names, job.name)
	}

	for _, name := range names {
		if name == nswSource {
			t.Fatalf("scheduled official jobs include %q; NSW PSI must run from residential egress only", nswSource)
		}
	}
	for _, want := range []string{"vg_sa", "vg_vic"} {
		found := false
		for _, name := range names {
			if name == want {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("scheduled official jobs = %v; missing %q", names, want)
		}
	}
}

func TestRunNSWVGRigOrchestratesExitAndRefresh(t *testing.T) {
	tests := []struct {
		name          string
		ingestOK      bool
		freshnessCode int
		wantCode      int
		wantCalls     []string
	}{
		{
			name:      "ingest failure is terminal",
			ingestOK:  false,
			wantCode:  1,
			wantCalls: []string{"ingest"},
		},
		{
			name:          "persisted data is stale",
			ingestOK:      true,
			freshnessCode: 1,
			wantCode:      1,
			wantCalls:     []string{"ingest", "freshness", "refresh"},
		},
		{
			name:      "successful fresh ingest",
			ingestOK:  true,
			wantCode:  0,
			wantCalls: []string{"ingest", "freshness", "refresh"},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			var calls []string
			code := runNSWVGRig(
				func() bool {
					calls = append(calls, "ingest")
					return tc.ingestOK
				},
				func() int {
					calls = append(calls, "freshness")
					return tc.freshnessCode
				},
				func() {
					calls = append(calls, "refresh")
				},
			)

			if code != tc.wantCode {
				t.Fatalf("exit code = %d, want %d", code, tc.wantCode)
			}
			if !reflect.DeepEqual(calls, tc.wantCalls) {
				t.Fatalf("calls = %v, want %v", calls, tc.wantCalls)
			}
		})
	}
}

func TestCollectorTimeoutMinutesUsesNSWOverride(t *testing.T) {
	t.Setenv("VG_NSW_TIMEOUT_MIN", "17")
	t.Setenv("CRAWL_TIMEOUT_MIN", "99")

	if got := collectorTimeoutMinutes("vg-nsw"); got != 17 {
		t.Fatalf("vg-nsw timeout = %d, want VG_NSW_TIMEOUT_MIN value 17", got)
	}
	if got := collectorTimeoutMinutes("official"); got != 99 {
		t.Fatalf("official timeout = %d, want CRAWL_TIMEOUT_MIN value 99", got)
	}
}
