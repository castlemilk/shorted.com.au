// Prefetch only integration-test images. Never retry a test command here.
package main

import (
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"syscall"
	"time"
)

const (
	pullAttempts   = 3
	commandTimeout = 60 * time.Second
)

type prefetcher struct {
	run  func(context.Context, ...string) error
	wait func(context.Context, time.Duration) error
	log  io.Writer
}

func pause(ctx context.Context, delay time.Duration) error {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

func (p prefetcher) command(ctx context.Context, args ...string) error {
	timeout := commandTimeout
	if args[0] == "image" {
		timeout = 10 * time.Second
	}
	bounded, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	err := p.run(bounded, args...)
	if bounded.Err() != nil {
		return bounded.Err()
	}
	return err
}

func (p prefetcher) fetch(ctx context.Context, images []string) error {
	seen := make(map[string]bool)
	for _, image := range images {
		if seen[image] {
			continue
		}
		seen[image] = true
		var lastErr error
		for attempt := 1; attempt <= pullAttempts; attempt++ {
			if err := ctx.Err(); err != nil {
				return err
			}
			// Recheck before each pull: another job may have filled the cache.
			if p.command(ctx, "image", "inspect", image) == nil {
				fmt.Fprintf(p.log, "Integration image cached: %s\n", image)
				break
			}
			fmt.Fprintf(p.log, "Pulling integration image %s (%d/%d)\n", image, attempt, pullAttempts)
			lastErr = p.command(ctx, "pull", image)
			if lastErr == nil {
				break
			}
			if attempt == pullAttempts {
				return fmt.Errorf("prefetch %s exhausted %d pull attempts: %w", image, pullAttempts, lastErr)
			}
			if err := p.wait(ctx, time.Duration(attempt)*2*time.Second); err != nil {
				return err
			}
		}
	}
	return nil
}

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: prefetch-integration-images IMAGE [IMAGE...]")
		os.Exit(2)
	}
	p := prefetcher{
		run: func(ctx context.Context, args ...string) error {
			cmd := exec.CommandContext(ctx, "docker", args...)
			// Inspect output is metadata; pull output contains registry diagnostics.
			if args[0] == "pull" {
				cmd.Stdout = os.Stdout
				cmd.Stderr = os.Stderr
			}
			return cmd.Run()
		},
		wait: pause,
		log:  os.Stdout,
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := p.fetch(ctx, os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
