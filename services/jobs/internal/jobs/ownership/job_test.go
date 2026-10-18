package ownership

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/castlemilk/shorted.com.au/services/jobs/internal/platform"
	"github.com/castlemilk/shorted.com.au/services/jobs/internal/runner"
)

func TestRevalidate(t *testing.T) {
	var got []platform.RevalidateRequest
	ping := func(r platform.RevalidateRequest) { got = append(got, r) }

	revalidate(context.Background(), 0, ping)
	if len(got) != 1 || got[0].Tag != "ownership" || got[0].Flush != "ownership" {
		t.Fatalf("ping = %+v, want one request for tag and flush ownership", got)
	}

	// A run whose context ends during the wait stored its rows; the pages
	// self-heal, and no ping is sent for a cache that has not turned over.
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	revalidate(ctx, time.Hour, ping)
	if len(got) != 1 {
		t.Fatalf("a cancelled wait pinged: %+v", got)
	}
}

func TestOutcome(t *testing.T) {
	if err := outcome(nil, 5); err != nil {
		t.Errorf("no failures: %v", err)
	}
	var exit *runner.ExitCodeError
	if err := outcome([]string{"etf:IOZ"}, 5); !errors.As(err, &exit) || exit.Code != exitCodeDegraded {
		t.Errorf("one failure of five = %v, want DEGRADED (exit %d)", err, exitCodeDegraded)
	}
	if err := outcome([]string{"a", "b"}, 2); err == nil || errors.As(err, &exit) {
		t.Errorf("every source failed = %v, want a plain error (exit 1)", err)
	}
}

func TestDefaultDryRun(t *testing.T) {
	t.Setenv("OWNERSHIP_DRY_RUN", "")
	if !defaultDryRun(false) {
		t.Error("a hand run must not write by default")
	}
	t.Setenv("OWNERSHIP_DRY_RUN", "false")
	if defaultDryRun(false) {
		t.Error("OWNERSHIP_DRY_RUN=false must write")
	}
	if !defaultDryRun(true) {
		t.Error("the global -dry-run wins over the variable")
	}
}
