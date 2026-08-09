package houseprices

import (
	"errors"
	"testing"
)

func TestOfficialLifecycleFatalWhenRefreshFailsWithHealthySources(t *testing.T) {
	t.Parallel()

	if !officialLifecycleFatal(16, 0, 15, errors.New("refresh failed")) {
		t.Fatal("MV refresh failure must be fatal even when every official source succeeds")
	}
}

func TestEnqueueExitCode(t *testing.T) {
	t.Parallel()

	if got := enqueueExitCode(nil); got != 0 {
		t.Fatalf("enqueueExitCode(nil) = %d, want 0", got)
	}
	if got := enqueueExitCode(errors.New("queue unavailable")); got != 7 {
		t.Fatalf("enqueueExitCode(error) = %d, want 7", got)
	}
}

func TestOfficialRunFatal(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name        string
		total       int
		failures    int
		maxFailures int
		want        bool
	}{
		{name: "default permits partial failures", total: 16, failures: 15, maxFailures: 15, want: false},
		{name: "total failure is fatal", total: 16, failures: 16, maxFailures: 15, want: true},
		{name: "stricter threshold permits seven", total: 16, failures: 7, maxFailures: 7, want: false},
		{name: "stricter threshold rejects eight", total: 16, failures: 8, maxFailures: 7, want: true},
		{name: "oversized threshold cannot disable total failure", total: 16, failures: 16, maxFailures: 99, want: true},
		{name: "negative threshold is bounded to zero", total: 16, failures: 1, maxFailures: -1, want: true},
		{name: "no configured sources fails closed", total: 0, failures: 0, maxFailures: -1, want: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			if got := officialRunFatal(tt.total, tt.failures, tt.maxFailures); got != tt.want {
				t.Fatalf("officialRunFatal(%d, %d, %d) = %v, want %v", tt.total, tt.failures, tt.maxFailures, got, tt.want)
			}
		})
	}
}

func TestAgentExitCode(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name     string
		rewarm   bool
		fatalErr bool
		done     int
		want     int
	}{
		{name: "rewarm keeps priority", rewarm: true, fatalErr: true, done: 0, want: 3},
		{name: "fatal before any work is distinct", fatalErr: true, done: 0, want: 7},
		{name: "fatal after completed work remains success", fatalErr: true, done: 1, want: 0},
		{name: "empty queue remains success", fatalErr: false, done: 0, want: 0},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			if got := agentExitCode(tt.rewarm, tt.fatalErr, tt.done); got != tt.want {
				t.Fatalf("agentExitCode(%v, %v, %d) = %d, want %d", tt.rewarm, tt.fatalErr, tt.done, got, tt.want)
			}
		})
	}
}
