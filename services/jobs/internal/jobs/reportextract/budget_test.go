package reportextract

import "testing"

// The run budget is the last line of cost defence on a PAID Gemini batch, so
// every branch of extract.py's resolve_gemini_run_budget is pinned.
func TestResolveGeminiRunBudget(t *testing.T) {
	tests := []struct {
		name                   string
		envItems, envWorkers   string
		limit, workers         int
		defItems, defWorkers   int
		wantLimit, wantWorkers int
		wantErr                bool
	}{
		{
			name:  "limit 0 means unlimited and clamps to the cap",
			limit: 0, workers: 1, defItems: 10, defWorkers: 1,
			wantLimit: 10, wantWorkers: 1,
		},
		{
			name:  "limit above the cap clamps",
			limit: 5000, workers: 8, defItems: 10, defWorkers: 2,
			wantLimit: 10, wantWorkers: 2,
		},
		{
			name:  "limit below the cap is kept",
			limit: 3, workers: 1, defItems: 10, defWorkers: 2,
			wantLimit: 3, wantWorkers: 1,
		},
		{
			name:  "negative limit clamps to the cap",
			limit: -1, workers: 1, defItems: 20, defWorkers: 2,
			wantLimit: 20, wantWorkers: 1,
		},
		{
			name:  "workers below 1 floors at 1",
			limit: 5, workers: 0, defItems: 10, defWorkers: 2,
			wantLimit: 5, wantWorkers: 1,
		},
		{
			name:     "env overrides both caps",
			envItems: "3", envWorkers: "1",
			limit: 100, workers: 8, defItems: 10, defWorkers: 2,
			wantLimit: 3, wantWorkers: 1,
		},
		{
			name:     "blank env falls back to the default cap",
			envItems: "   ",
			limit:    0, workers: 1, defItems: 7, defWorkers: 1,
			wantLimit: 7, wantWorkers: 1,
		},
		{
			name:     "non-numeric env is an error, never a silent unlimited",
			envItems: "lots",
			limit:    1, workers: 1, defItems: 10, defWorkers: 1,
			wantErr: true,
		},
		{
			name:       "zero env is an error",
			envWorkers: "0",
			limit:      1, workers: 1, defItems: 10, defWorkers: 1,
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if tt.envItems != "" {
				t.Setenv(envMaxRunItems, tt.envItems)
			}
			if tt.envWorkers != "" {
				t.Setenv(envMaxRunWorkers, tt.envWorkers)
			}
			gotLimit, gotWorkers, err := resolveGeminiRunBudget(tt.limit, tt.workers, tt.defItems, tt.defWorkers)
			if tt.wantErr {
				if err == nil {
					t.Fatalf("want error, got limit=%d workers=%d", gotLimit, gotWorkers)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if gotLimit != tt.wantLimit || gotWorkers != tt.wantWorkers {
				t.Errorf("got limit=%d workers=%d, want %d/%d", gotLimit, gotWorkers, tt.wantLimit, tt.wantWorkers)
			}
		})
	}
}

// The three call sites' caps are a deployment contract (the Cloud Run jobs set
// GEMINI_MAX_RUN_ITEMS/_WORKERS to match), so the defaults are pinned here.
func TestRunBudgetDefaultsMatchTheirScripts(t *testing.T) {
	for _, tt := range []struct {
		name               string
		items, workers     int
		wantItems, wantWkr int
	}{
		{"sequential (extract.py)", sequentialDefaultMaxItems, sequentialDefaultMaxWorkers, 10, 1},
		{"concurrent (extract_reports_concurrent.py)", concurrentDefaultMaxItems, concurrentDefaultMaxWorkers, 10, 2},
		{"director (extract_director_trades.py)", directorDefaultMaxItems, directorDefaultMaxWorkers, 20, 2},
	} {
		if tt.items != tt.wantItems || tt.workers != tt.wantWkr {
			t.Errorf("%s: got %d/%d, want %d/%d", tt.name, tt.items, tt.workers, tt.wantItems, tt.wantWkr)
		}
	}
}
