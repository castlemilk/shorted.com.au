package main

import (
	"encoding/json"
	"io"
	"log"
	"os"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

// Round progress events for `-mode agent`, written as NDJSON to the file
// descriptor named by CRAWL_EVENTS_FD (an fd the parent process passes in).
// Unset, nothing is written and behaviour is unchanged.
//
// Hard rules:
//   - events are emitted ONLY from the real work loop (roundIO.run in
//     crawl_agent.go) and from the round's own lifecycle, never from a timer;
//   - NO suburb names, addresses, URLs or free text. Job IDs and enums only;
//   - a write error (EPIPE: the parent died) marks the writer broken, and the
//     loop stops claiming new work.
//
// Schema (every event carries "event" and "ts", RFC3339Nano UTC):
//
//	claim            {job_id}
//	page             {job_id, source: rea|domain}   one per source sweep started
//	submit           {job_id, outcome: succeeded|failed|deferred, listings, events, blocked}
//	finalize_started {}
//	ingest_ok        {job_id, source, applied, replayed}   CRAWL_SINK=ingest, one per accepted push;
//	                  applied is complete|partial|blocked
//	ingest_error     {job_id, source, code}   one per failed push; code is a Connect code
//	                  word, "token" or "transport". Never the server's message text
//	shadow           {job_id, source, legacy_events, legacy_failed, dry_events,
//	                  dry_quarantined, dry_poisoned, dry_applied, push_error,
//	                  push_reason, parity}   CRAWL_SINK=shadow only, one per sweep
//	shadow_circuit   {failures}   CRAWL_SINK=shadow only, once, when shadow switches off
//	                  after shadowFailLimit consecutive dry-run failures
//	round_done       {processed, succeeded, failed, deferred, listings, events,
//	                  blocked_sweeps, needs_rewarm, chrome_unusable, env_broken}
const crawlEventsFDEnv = "CRAWL_EVENTS_FD"

type eventHeader struct {
	Event string `json:"event"`
	TS    string `json:"ts"`
}

type claimEvent struct {
	eventHeader
	JobID string `json:"job_id"`
}

type pageEvent struct {
	eventHeader
	JobID  string `json:"job_id"`
	Source string `json:"source"`
}

type submitEvent struct {
	eventHeader
	JobID    string `json:"job_id"`
	Outcome  string `json:"outcome"`
	Listings int    `json:"listings"`
	Events   int    `json:"events"`
	Blocked  int    `json:"blocked"`
}

type finalizeStartedEvent struct {
	eventHeader
}

type roundDoneEvent struct {
	eventHeader
	Processed      int  `json:"processed"`
	Succeeded      int  `json:"succeeded"`
	Failed         int  `json:"failed"`
	Deferred       int  `json:"deferred"`
	Listings       int  `json:"listings"`
	Events         int  `json:"events"`
	BlockedSweeps  int  `json:"blocked_sweeps"`
	NeedsRewarm    bool `json:"needs_rewarm"`
	ChromeUnusable bool `json:"chrome_unusable"`
	EnvBroken      bool `json:"env_broken"`
}

// exitChromeUnusable is the round exit code for "Chrome unusable even after
// self-warm" (see runAgentRound). Named here so round_done can report it.
const exitChromeUnusable = 4

// jobIDPattern admits brandbrain's ID shape only. Anything else is written as
// "invalid" rather than echoed, so a malformed ID cannot smuggle text out.
var jobIDPattern = regexp.MustCompile(`^[A-Za-z0-9-]{1,64}$`)

// crawlEvents is the writer. A nil *crawlEvents is a valid, disabled writer, so
// call sites never need to check for the environment.
type crawlEvents struct {
	mu     sync.Mutex
	w      io.Writer
	now    func() time.Time
	isBad  bool
	badErr error
}

// newCrawlEvents wraps w. A nil w returns a disabled writer.
func newCrawlEvents(w io.Writer) *crawlEvents {
	if w == nil {
		return nil
	}
	return &crawlEvents{w: w, now: time.Now}
}

// newCrawlEventsFromEnv opens CRAWL_EVENTS_FD. Unset or invalid means disabled.
// fd 0-2 are refused so the stream can never corrupt stdio.
func newCrawlEventsFromEnv() *crawlEvents {
	raw := strings.TrimSpace(os.Getenv(crawlEventsFDEnv))
	if raw == "" {
		return nil
	}
	fd, err := strconv.Atoi(raw)
	if err != nil || fd < 3 {
		log.Printf("[agent] %s=%q is not a usable fd (need an integer >= 3); events disabled", crawlEventsFDEnv, raw)
		return nil
	}
	// Close-on-exec, so children we exec (the detached Chrome, the playwright
	// driver) do not inherit the events pipe. Otherwise a future -mode cycle parent
	// never sees EOF while those children live.
	syscall.CloseOnExec(fd)
	return newCrawlEvents(os.NewFile(uintptr(fd), "crawl-events"))
}

// broken reports whether a write has failed (the parent went away).
func (e *crawlEvents) broken() bool {
	if e == nil {
		return false
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.isBad
}

// emit builds and writes one event under the lock. After the first failure it
// writes nothing and only reports the broken state.
func (e *crawlEvents) emit(build func() any) {
	if e == nil {
		return
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.isBad {
		return
	}
	b, err := json.Marshal(build())
	if err == nil {
		_, err = e.w.Write(append(b, '\n'))
	}
	if err != nil {
		e.isBad = true
		e.badErr = err
		log.Printf("[agent] crawl events stream closed (%v) — stopping new claims", err)
	}
}

func (e *crawlEvents) header(event string) eventHeader {
	return eventHeader{Event: event, TS: e.now().UTC().Format(time.RFC3339Nano)}
}

func safeJobID(id string) string {
	if jobIDPattern.MatchString(id) {
		return id
	}
	return "invalid"
}

func (e *crawlEvents) claim(jobID string) {
	e.emit(func() any {
		return claimEvent{eventHeader: e.header("claim"), JobID: safeJobID(jobID)}
	})
}

// page records that one source sweep started. Sources outside the enum are dropped.
func (e *crawlEvents) page(jobID, source string) {
	if source != "rea" && source != "domain" {
		return
	}
	e.emit(func() any {
		return pageEvent{eventHeader: e.header("page"), JobID: safeJobID(jobID), Source: source}
	})
}

// submit records the outcome sent to the queue (the deferred-to-failed fallback
// sends "failed"). Outcomes outside the enum are dropped.
func (e *crawlEvents) submit(jobID, outcome string, listings, events, blocked int) {
	if outcome != "succeeded" && outcome != "failed" && outcome != "deferred" {
		return
	}
	e.emit(func() any {
		return submitEvent{
			eventHeader: e.header("submit"), JobID: safeJobID(jobID), Outcome: outcome,
			Listings: listings, Events: events, Blocked: blocked,
		}
	})
}

// shadowParity is one sweep's parity record in shadow mode. Every field is an ID, a
// count, a boolean or an enum, and push_reason is only ever a server reason from the
// ingest's fixed vocabulary, so no listing or suburb name can reach this stream.
// parity is one of match, diverge, legacy_error, not_dispatched or push_error.
type shadowParity struct {
	JobID          string
	Source         string
	LegacyEvents   int
	LegacyFailed   bool
	DryEvents      int
	DryQuarantined bool
	DryPoisoned    bool
	DryApplied     string
	PushError      string
	PushReason     string
	Parity         string
}

type shadowEvent struct {
	eventHeader
	JobID          string `json:"job_id"`
	Source         string `json:"source"`
	LegacyEvents   int    `json:"legacy_events"`
	LegacyFailed   bool   `json:"legacy_failed"`
	DryEvents      int    `json:"dry_events"`
	DryQuarantined bool   `json:"dry_quarantined"`
	DryPoisoned    bool   `json:"dry_poisoned"`
	DryApplied     string `json:"dry_applied"`
	PushError      string `json:"push_error"`
	PushReason     string `json:"push_reason"`
	Parity         string `json:"parity"`
}

// shadowParity writes one parity record. A nil writer is a no-op, as for every event.
func (e *crawlEvents) shadowParity(p shadowParity) {
	e.emit(func() any {
		return shadowEvent{
			eventHeader:    e.header("shadow"),
			JobID:          safeJobID(p.JobID),
			Source:         sourceEnum(p.Source),
			LegacyEvents:   p.LegacyEvents,
			LegacyFailed:   p.LegacyFailed,
			DryEvents:      p.DryEvents,
			DryQuarantined: p.DryQuarantined,
			DryPoisoned:    p.DryPoisoned,
			DryApplied:     p.DryApplied,
			PushError:      p.PushError,
			PushReason:     enumOrEmpty(p.PushReason, parityReasons),
			Parity:         enumOrEmpty(p.Parity, parityOutcomes),
		}
	})
}

// parityOutcomes is the closed set of parity values a shadow event may carry.
var parityOutcomes = map[string]bool{
	"match": true, "diverge": true, "legacy_error": true, "not_dispatched": true, "push_error": true,
}

// sourceEnum keeps a portal name only when it is one of the two known portals.
func sourceEnum(s string) string {
	if s == "rea" || s == "domain" {
		return s
	}
	return "invalid"
}

// enumOrEmpty returns v when it is in the allowed set, and "" otherwise.
func enumOrEmpty(v string, allowed map[string]bool) string {
	if allowed[v] {
		return v
	}
	return ""
}

func (e *crawlEvents) finalizeStarted() {
	e.emit(func() any { return finalizeStartedEvent{eventHeader: e.header("finalize_started")} })
}

// roundDone is the round's last event. It is emitted on every return from
// runAgent, so a parent always sees exactly one per round. code is the round's
// exit code, which is what distinguishes the Chrome (4) and environment (8) stops.
func (e *crawlEvents) roundDone(res roundResult, code int) {
	e.emit(func() any {
		return roundDoneEvent{
			eventHeader:    e.header("round_done"),
			Processed:      res.processed,
			Succeeded:      res.succeeded,
			Failed:         res.failed,
			Deferred:       res.deferred,
			Listings:       res.listings,
			Events:         res.events,
			BlockedSweeps:  res.blockedSweeps,
			NeedsRewarm:    res.anyRewarm,
			ChromeUnusable: code == exitChromeUnusable,
			EnvBroken:      code == exitCrawlEnvBroken,
		}
	})
}

// ingestOKEvent is one accepted ingest push. applied is complete|partial|blocked. The
// counts stay in the job summary, so the stream carries identifiers and enums only.
type ingestOKEvent struct {
	eventHeader
	JobID    string `json:"job_id"`
	Source   string `json:"source"`
	Applied  string `json:"applied"`
	Replayed bool   `json:"replayed"`
}

// ingestErrorEvent is one failed ingest push, named by its code word alone.
type ingestErrorEvent struct {
	eventHeader
	JobID  string `json:"job_id"`
	Source string `json:"source"`
	Code   string `json:"code"`
}

// shadowCircuitEvent records shadow switching off for the rest of the process.
type shadowCircuitEvent struct {
	eventHeader
	Failures int `json:"failures"`
}

// ingestCodeWords is the closed set of codes an ingest_error event may carry. Anything
// else is written as "other", so no text from the server can reach the stream.
var ingestCodeWords = map[string]bool{
	"unavailable": true, "internal": true, "unknown": true, "deadline_exceeded": true,
	"unauthenticated": true, "permission_denied": true, "resource_exhausted": true,
	"failed_precondition": true, "already_exists": true, "invalid_argument": true,
	"not_found": true, "unimplemented": true, "canceled": true, "token": true, "transport": true,
}

// ingestOK writes one ingest_ok event. A nil writer is a no-op.
func (e *crawlEvents) ingestOK(jobID, source, applied string, replayed bool) {
	e.emit(func() any {
		return ingestOKEvent{
			eventHeader: e.header("ingest_ok"), JobID: safeJobID(jobID), Source: sourceEnum(source),
			Applied:  enumOrEmpty(applied, map[string]bool{"complete": true, "partial": true, "blocked": true}),
			Replayed: replayed,
		}
	})
}

// ingestError writes one ingest_error event.
func (e *crawlEvents) ingestError(jobID, source, code string) {
	if !ingestCodeWords[code] {
		code = "other"
	}
	e.emit(func() any {
		return ingestErrorEvent{eventHeader: e.header("ingest_error"), JobID: safeJobID(jobID), Source: sourceEnum(source), Code: code}
	})
}

// shadowCircuit writes the one shadow_circuit event.
func (e *crawlEvents) shadowCircuit(failures int) {
	e.emit(func() any {
		return shadowCircuitEvent{eventHeader: e.header("shadow_circuit"), Failures: failures}
	})
}
