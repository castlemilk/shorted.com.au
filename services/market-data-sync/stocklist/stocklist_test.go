package stocklist

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestPrioritize(t *testing.T) {
	service := &Service{}

	tests := []struct {
		name         string
		all          []string
		priority     []string
		wantPriority int
		wantTotal    int
	}{
		{
			name:         "empty lists",
			all:          []string{},
			priority:     []string{},
			wantPriority: 0,
			wantTotal:    0,
		},
		{
			name:         "no priority stocks",
			all:          []string{"AAA", "BBB", "CCC"},
			priority:     []string{},
			wantPriority: 0,
			wantTotal:    3,
		},
		{
			name:         "all priority stocks",
			all:          []string{"AAA", "BBB", "CCC"},
			priority:     []string{"AAA", "BBB", "CCC"},
			wantPriority: 3,
			wantTotal:    3,
		},
		{
			name:         "mixed priority and non-priority",
			all:          []string{"AAA", "BBB", "CCC", "DDD", "EEE"},
			priority:     []string{"BBB", "DDD"},
			wantPriority: 2,
			wantTotal:    5,
		},
		{
			name:         "priority stocks not in all list",
			all:          []string{"AAA", "BBB", "CCC"},
			priority:     []string{"XXX", "YYY"},
			wantPriority: 2,
			wantTotal:    5, // 2 priority + 3 from all
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := service.prioritize(tt.all, tt.priority)

			// Count priority stocks
			priorityCount := 0
			for _, s := range result {
				if s.IsPriority {
					priorityCount++
				}
			}

			assert.Equal(t, tt.wantPriority, priorityCount, "priority count mismatch")
			assert.Equal(t, tt.wantTotal, len(result), "total count mismatch")

			// Verify priority stocks come first
			if len(tt.priority) > 0 && len(result) > 0 {
				for i := 0; i < len(tt.priority) && i < len(result); i++ {
					assert.True(t, result[i].IsPriority, "first %d stocks should be priority", len(tt.priority))
				}
			}
		})
	}
}

func TestPrioritize_Order(t *testing.T) {
	service := &Service{}

	all := []string{"AAA", "BBB", "CCC", "DDD", "EEE"}
	priority := []string{"DDD", "BBB"} // DDD first, then BBB

	result := service.prioritize(all, priority)

	// Priority stocks should come first, in the order specified
	assert.Equal(t, "DDD", result[0].Code)
	assert.True(t, result[0].IsPriority)
	assert.Equal(t, "BBB", result[1].Code)
	assert.True(t, result[1].IsPriority)

	// Remaining stocks should follow
	assert.Equal(t, "AAA", result[2].Code)
	assert.False(t, result[2].IsPriority)
	assert.Equal(t, "CCC", result[3].Code)
	assert.False(t, result[3].IsPriority)
	assert.Equal(t, "EEE", result[4].Code)
	assert.False(t, result[4].IsPriority)
}

func TestCountPriority(t *testing.T) {
	tests := []struct {
		name   string
		stocks []Stock
		want   int
	}{
		{
			name:   "empty list",
			stocks: []Stock{},
			want:   0,
		},
		{
			name: "no priority",
			stocks: []Stock{
				{Code: "AAA", IsPriority: false},
				{Code: "BBB", IsPriority: false},
			},
			want: 0,
		},
		{
			name: "all priority",
			stocks: []Stock{
				{Code: "AAA", IsPriority: true},
				{Code: "BBB", IsPriority: true},
			},
			want: 2,
		},
		{
			name: "mixed",
			stocks: []Stock{
				{Code: "AAA", IsPriority: true},
				{Code: "BBB", IsPriority: false},
				{Code: "CCC", IsPriority: true},
			},
			want: 2,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := CountPriority(tt.stocks)
			assert.Equal(t, tt.want, got)
		})
	}
}
