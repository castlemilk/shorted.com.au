package main

import "context"

// probeIngestRound runs ProbeAuth for one round. It is called from runAgentRound, after
// the lock is held and the signal handlers are installed. A stop request during the
// probe cancels the call, and the round exits exitCrawlCancelled, because a cancel
// beats every other code (finalExitCode).
func probeIngestRound(ctx context.Context, ir *ingestRound, stop *stopSignal) int {
	pctx, cancel := context.WithCancel(ctx)
	defer cancel()
	go func() {
		select {
		case <-stop.Done():
			cancel()
		case <-pctx.Done():
		}
	}()
	ir.events.startup("probe_auth", "start", "")
	code := ir.probe(pctx)
	outcome := "ok"
	switch {
	case stop.Reason() != "":
		outcome = "canceled"
	case code != 0:
		outcome = ir.lastProbeWord()
	}
	ir.events.startup("probe_auth", "done", outcome)
	if stop.Reason() != "" {
		return exitCrawlCancelled
	}
	return code
}
