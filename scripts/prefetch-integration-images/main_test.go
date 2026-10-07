package main

import (
	"context"
	"errors"
	"io"
	"reflect"
	"testing"
	"time"
)

func TestPrefetch(t *testing.T) {
	registryErr := errors.New("registry connection reset")
	tests := []struct {
		name      string
		cachedAt  int
		pullFails int
		pulls     int
		waits     []time.Duration
		wantErr   bool
	}{
		{name: "cache hit", cachedAt: 1},
		{name: "cold cache", pulls: 1},
		{name: "transient failure", pullFails: 1, pulls: 2, waits: []time.Duration{2 * time.Second}},
		{name: "another job filled cache", cachedAt: 2, pullFails: 1, pulls: 1, waits: []time.Duration{2 * time.Second}},
		{name: "exhaustion", pullFails: 3, pulls: 3, waits: []time.Duration{2 * time.Second, 4 * time.Second}, wantErr: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			pulls, inspections := 0, 0
			var waits []time.Duration
			p := prefetcher{
				log: io.Discard,
				run: func(ctx context.Context, args ...string) error {
					deadline, ok := ctx.Deadline()
					if !ok || time.Until(deadline) > commandTimeout {
						t.Fatal("Docker command has no bounded deadline")
					}
					if args[0] == "image" {
						inspections++
						if tt.cachedAt > 0 && inspections >= tt.cachedAt {
							return nil
						}
						return errors.New("image absent")
					}
					pulls++
					if pulls <= tt.pullFails {
						return registryErr
					}
					return nil
				},
				wait: func(_ context.Context, d time.Duration) error {
					waits = append(waits, d)
					return nil
				},
			}
			// Duplicate images should not cause duplicate pulls or checks.
			err := p.fetch(context.Background(), []string{"postgres:15-alpine", "postgres:15-alpine"})
			if (err != nil) != tt.wantErr || (tt.wantErr && !errors.Is(err, registryErr)) {
				t.Fatalf("error = %v, expected registry failure = %v", err, tt.wantErr)
			}
			if pulls != tt.pulls || !reflect.DeepEqual(waits, tt.waits) {
				t.Fatalf("pulls/waits = %d/%v, want %d/%v", pulls, waits, tt.pulls, tt.waits)
			}
		})
	}
}

func TestExhaustionStopsBeforeNextImage(t *testing.T) {
	p := prefetcher{
		log: io.Discard,
		run: func(_ context.Context, args ...string) error {
			if args[len(args)-1] != "first" {
				t.Fatal("continued after failure")
			}
			return errors.New("unavailable")
		},
		wait: func(context.Context, time.Duration) error { return nil },
	}
	if p.fetch(context.Background(), []string{"first", "second"}) == nil {
		t.Fatal("failure was swallowed")
	}
}

func TestCanceledPrefetch(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	p := prefetcher{log: io.Discard, run: func(context.Context, ...string) error {
		t.Fatal("ran a Docker command after cancellation")
		return nil
	}}
	if err := p.fetch(ctx, []string{"postgres"}); !errors.Is(err, context.Canceled) {
		t.Fatalf("error = %v", err)
	}
	if err := pause(ctx, time.Hour); !errors.Is(err, context.Canceled) {
		t.Fatalf("pause error = %v", err)
	}
}

func TestCommandPropagatesDeadline(t *testing.T) {
	ctx, cancel := context.WithDeadline(context.Background(), time.Now().Add(-time.Second))
	defer cancel()
	p := prefetcher{run: func(context.Context, ...string) error { return nil }}
	if err := p.command(ctx, "pull", "postgres"); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("deadline was swallowed: %v", err)
	}
}
