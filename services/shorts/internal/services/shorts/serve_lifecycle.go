package shorts

import (
	"context"
	"errors"
	"net"
	"net/http"
	"time"
)

// ShutdownGrace bounds how long Serve waits for in-flight requests after its
// context ends. Cloud Run sends SIGTERM and kills the container 10s later, and
// main still has to flush the rate-limit quota buffer (s.Close) after Serve
// returns, so the drain gets the smaller share of that window. A request still
// running at the deadline (an MCP listen stream holds for up to 90s) is cut.
const ShutdownGrace = 5 * time.Second

// serveUntilDone serves srv on ln until ctx ends, then shuts it down gracefully
// within grace. It returns nil for a shutdown the context asked for, and the
// listener's error when serving fails on its own.
//
// Serve used to be a bare http.ListenAndServe that never looked at its
// context: SIGTERM cancelled main's errgroup, but g.Wait blocked on Serve
// forever, so the process ignored the signal until Cloud Run SIGKILLed it and
// the monthly-quota flush in s.Close() never ran.
func serveUntilDone(ctx context.Context, srv *http.Server, ln net.Listener, grace time.Duration) error {
	errC := make(chan error, 1)
	go func() { errC <- srv.Serve(ln) }()

	select {
	case err := <-errC:
		return err
	case <-ctx.Done():
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), grace)
	defer cancel()
	shutdownErr := srv.Shutdown(shutdownCtx)
	// Serve returns ErrServerClosed as soon as Shutdown closes the listener.
	if err := <-errC; err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	if shutdownErr != nil && !errors.Is(shutdownErr, context.DeadlineExceeded) {
		return shutdownErr
	}
	return nil
}
