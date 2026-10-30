package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// crawl_circuit_state.go persists the per-source circuit breaker (crawl_circuit.go) between the
// child rounds and cycles of one housing crawl. Each round is a fresh -mode agent process, so an
// in-memory breaker restarts every source at the base cooldown: a Domain block that doubled to the
// cap in one round was probed again at 5 minutes in the next (2026-10-30). The file keeps the streak
// and the backoff.
//
// Only a lock holder writes it. A child round runs under its parent's lock (withCrawlLock passthrough)
// and a standalone -mode agent takes the lock itself, so there is never a second writer. A dry run
// never writes: its blocks are not the portal's.

const (
	circuitStateEnv     = "CRAWL_CIRCUIT_STATE_FILE"
	circuitStateVersion = 1
)

// circuitStatePath is the state file: CRAWL_CIRCUIT_STATE_FILE if set, else
// ~/.shorted-housing-crawl/circuit-state.json beside the driver directory. "" (no home) keeps the
// breaker in memory.
func circuitStatePath() string {
	if v := strings.TrimSpace(os.Getenv(circuitStateEnv)); v != "" {
		return v
	}
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return ""
	}
	return filepath.Join(home, ".shorted-housing-crawl", "circuit-state.json")
}

// circuitStateFile is the on-disk shape. Durations are nanoseconds, times RFC 3339.
type circuitStateFile struct {
	Version int                          `json:"version"`
	Sources map[string]circuitStateEntry `json:"sources"`
}

type circuitStateEntry struct {
	Consec    int       `json:"consec"`
	OpenUntil time.Time `json:"open_until"`
	BackoffNS int64     `json:"backoff_ns"`
	Updated   time.Time `json:"updated"`
}

// circuitPathForRun is the state file a round may use. A dry run gets "" (memory only): its blocks
// are not the portal's, so it must neither read nor write the real state.
func circuitPathForRun(dryRun bool) string {
	if dryRun {
		return ""
	}
	return circuitStatePath()
}

// newPersistentCircuitBreaker builds a breaker that saves to path (empty means memory only) and
// restores the state already there. An entry whose openUntil and last update are both more than
// the cap (CRAWL_CIRCUIT_MAX_S) in the past is expired and dropped, so an old streak no longer
// lengthens the next cooldown. A missing file is a fresh start. A corrupt or unreadable file is
// logged and also a fresh start: the breaker must never stop a crawl.
func newPersistentCircuitBreaker(trip int, base, ceiling time.Duration, path string, now time.Time) *crawlCircuitBreaker {
	cb := newCircuitBreaker(trip, base, ceiling)
	cb.path = path
	if path == "" {
		return cb
	}
	removeStaleCircuitTemps(path)
	entries, err := readCircuitState(path)
	if err != nil {
		if !errors.Is(err, fs.ErrNotExist) {
			log.Printf("[agent] circuit state %s is unreadable (%v) — starting every source closed", path, err)
		}
		return cb
	}
	// A cooldown is at most cap, plus the 20% jitter in jitterDur. An openUntil past that is a
	// clock that was wrong when it was written, so it is clamped rather than trusted.
	horizon := now.Add(cb.max + cb.max/5)
	kept, expired, future := 0, 0, 0
	for name, e := range entries {
		if e.Updated.After(now) {
			future++ // written by a clock ahead of ours, or corrupt: not trusted
			continue
		}
		ref := e.Updated
		if e.OpenUntil.After(ref) {
			ref = e.OpenUntil
		}
		if now.Sub(ref) > cb.max {
			expired++
			continue
		}
		open := e.OpenUntil
		if open.After(horizon) {
			open = horizon
		}
		sc := &sourceCircuit{consec: max(e.Consec, 0), openUntil: open, backoff: min(max(time.Duration(e.BackoffNS), 0), cb.max), updated: e.Updated}
		cb.circuits[name] = sc
		kept++
	}
	if kept+expired+future > 0 {
		log.Printf("[agent] circuit state loaded from %s: %d source(s) carried over, %d expired, %d future-dated dropped", path, kept, expired, future)
	}
	return cb
}

// circuitTempMaxAge is how old a temp file must be before load treats it as left behind by a crash.
// A live writer holds the lock, so a fresh temp is never removed under it.
const circuitTempMaxAge = time.Minute

// removeStaleCircuitTemps deletes the ".circuit-state.json.*.tmp" files a crashed save left beside
// the state file. Errors are ignored: a temp that cannot be removed is only clutter.
func removeStaleCircuitTemps(path string) {
	dir, base := filepath.Dir(path), filepath.Base(path)
	ents, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	prefix, suffix := "."+base+".", ".tmp"
	for _, e := range ents {
		name := e.Name()
		if e.IsDir() || !strings.HasPrefix(name, prefix) || !strings.HasSuffix(name, suffix) {
			continue
		}
		info, err := e.Info()
		if err != nil || time.Since(info.ModTime()) < circuitTempMaxAge {
			continue
		}
		_ = os.Remove(filepath.Join(dir, name))
	}
}

// readCircuitState parses the state file. fs.ErrNotExist passes through unchanged.
func readCircuitState(path string) (map[string]circuitStateEntry, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var st circuitStateFile
	if err := json.Unmarshal(data, &st); err != nil {
		return nil, fmt.Errorf("parse: %w", err)
	}
	if st.Version != circuitStateVersion {
		return nil, fmt.Errorf("unknown state version %d", st.Version)
	}
	return st.Sources, nil
}

// save writes the breaker's state to its file. A failed write is logged and the breaker keeps
// running in memory: a state file that cannot be written must not stop the crawl.
func (cb *crawlCircuitBreaker) save() {
	if cb.path == "" {
		return
	}
	if err := writeCircuitState(cb.path, cb.circuits); err != nil {
		log.Printf("[agent] circuit state not saved to %s (%v) — the breaker runs in memory for this round", cb.path, err)
	}
}

// writeCircuitState replaces path atomically: a 0600 temp file in the same directory, synced, then
// renamed over the old file. A reader sees the old state or the new state, never a torn one. Sources
// with no state (closed, no streak, no backoff) are left out.
func writeCircuitState(path string, circuits map[string]*sourceCircuit) error {
	st := circuitStateFile{Version: circuitStateVersion, Sources: map[string]circuitStateEntry{}}
	for name, sc := range circuits {
		if sc.consec == 0 && sc.backoff == 0 && sc.openUntil.IsZero() {
			continue
		}
		st.Sources[name] = circuitStateEntry{
			Consec:    sc.consec,
			OpenUntil: sc.openUntil,
			BackoffNS: int64(sc.backoff),
			Updated:   sc.updated,
		}
	}
	data, err := json.MarshalIndent(st, "", "  ")
	if err != nil {
		return err
	}
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, "."+filepath.Base(path)+".*.tmp")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	renamed := false
	defer func() {
		if !renamed {
			_ = os.Remove(tmpName)
		}
	}()
	if err := tmp.Chmod(0o600); err != nil {
		_ = tmp.Close()
		return err
	}
	if _, err := tmp.Write(append(data, '\n')); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmpName, path); err != nil {
		return err
	}
	renamed = true
	return nil
}
