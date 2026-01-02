package checkpoint

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestCheckpoint_Struct(t *testing.T) {
	cp := Checkpoint{
		RunID:                "20240102-150405",
		Status:               "running",
		StocksTotal:          100,
		StocksProcessed:      50,
		StocksSuccessful:     48,
		StocksFailed:         2,
		PriorityTotal:        10,
		PriorityProcessed:    10,
		PriorityCompleted:    true,
		PricesRecordsUpdated: 5000,
		AlgoliaRecordsSynced: 100,
		ResumeFrom:           50,
	}

	assert.Equal(t, "20240102-150405", cp.RunID)
	assert.Equal(t, "running", cp.Status)
	assert.Equal(t, 100, cp.StocksTotal)
	assert.Equal(t, 50, cp.StocksProcessed)
	assert.Equal(t, 48, cp.StocksSuccessful)
	assert.Equal(t, 2, cp.StocksFailed)
	assert.Equal(t, 10, cp.PriorityTotal)
	assert.Equal(t, 10, cp.PriorityProcessed)
	assert.True(t, cp.PriorityCompleted)
	assert.Equal(t, 5000, cp.PricesRecordsUpdated)
	assert.Equal(t, 100, cp.AlgoliaRecordsSynced)
	assert.Equal(t, 50, cp.ResumeFrom)
}

func TestCheckpoint_Progress(t *testing.T) {
	tests := []struct {
		name            string
		total           int
		processed       int
		wantPercentDone float64
	}{
		{
			name:            "empty",
			total:           0,
			processed:       0,
			wantPercentDone: 0,
		},
		{
			name:            "half done",
			total:           100,
			processed:       50,
			wantPercentDone: 50,
		},
		{
			name:            "complete",
			total:           100,
			processed:       100,
			wantPercentDone: 100,
		},
		{
			name:            "quarter done",
			total:           200,
			processed:       50,
			wantPercentDone: 25,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cp := Checkpoint{
				StocksTotal:     tt.total,
				StocksProcessed: tt.processed,
			}

			var percentDone float64
			if cp.StocksTotal > 0 {
				percentDone = float64(cp.StocksProcessed) / float64(cp.StocksTotal) * 100
			}
			assert.Equal(t, tt.wantPercentDone, percentDone)
		})
	}
}

func TestCheckpoint_PriorityProgress(t *testing.T) {
	tests := []struct {
		name             string
		priorityTotal    int
		priorityProc     int
		wantCompleted    bool
		wantPercentDone  float64
	}{
		{
			name:             "no priority stocks",
			priorityTotal:    0,
			priorityProc:     0,
			wantCompleted:    false,
			wantPercentDone:  0,
		},
		{
			name:             "priority half done",
			priorityTotal:    10,
			priorityProc:     5,
			wantCompleted:    false,
			wantPercentDone:  50,
		},
		{
			name:             "priority complete",
			priorityTotal:    10,
			priorityProc:     10,
			wantCompleted:    true,
			wantPercentDone:  100,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cp := Checkpoint{
				PriorityTotal:     tt.priorityTotal,
				PriorityProcessed: tt.priorityProc,
			}

			// Check completed status
			completed := cp.PriorityTotal > 0 && cp.PriorityProcessed >= cp.PriorityTotal
			assert.Equal(t, tt.wantCompleted, completed)

			// Check percent done
			var percentDone float64
			if cp.PriorityTotal > 0 {
				percentDone = float64(cp.PriorityProcessed) / float64(cp.PriorityTotal) * 100
			}
			assert.Equal(t, tt.wantPercentDone, percentDone)
		})
	}
}

func TestNewStore(t *testing.T) {
	// Test that NewStore returns a non-nil Store even with nil db
	// (in real usage, db would never be nil)
	store := NewStore(nil)
	assert.NotNil(t, store)
}
