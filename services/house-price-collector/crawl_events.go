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
//	fetch            {job_id, source, page, outcome: ok|blocked|error}   one per page fetch
//	                  (S2): a dense sweep is many paced fetches, so this is the event that
//	                  proves the child is working. The cycle's hung timer runs off it.
//	submit           {job_id, outcome: succeeded|failed|deferred, listings, events, blocked}
//	finalize_started {}
//	ingest_ok        {job_id, source, applied, replayed, quarantined}   CRAWL_SINK=ingest, one
//	                  per accepted push; applied is complete|partial|blocked; quarantined is
//	                  true when the server held the sweep back for review
//	ingest_error     {job_id, source, code}   one per failed push; code is a Connect code
//	                  word, "token" or "transport". Never the server's message text
//	shadow           {job_id, source, legacy_events, legacy_failed, dry_events,
//	                  dry_quarantined, dry_poisoned, dry_applied, push_error,
//	                  push_reason, parity}   CRAWL_SINK=shadow only, one per sweep
//	shadow_circuit   {failures}   CRAWL_SINK=shadow only, once, when shadow switches off
//	                  after shadowFailLimit consecutive dry-run failures
//	ready            {}   the child's SIGTERM handler is installed (written first, by runAgent).
//	                  The cycle sends its one graceful SIGTERM only after this.
//	startup          {step: probe_auth|warm_probe, phase: start|done, outcome}   start-up work,
//	                  written when a step begins and ends (never on a timer), so a slow start-up
//	                  is not a silence. outcome is set on done.
//	ingest_ok        {probe: true}   ProbeAuth accepted; ingest_error {probe: true, code}   the
//	                  contract's ingest.probe word. Pushes never carry probe.
//	round_done       {processed, succeeded, failed, deferred, listings, events,
//	                  blocked_sweeps, needs_rewarm, chrome_unusable, env_broken}
//	The -mode cycle parent (crawl_cycle.go) forwards every event above except a child's
//	round_done, adding "round", and writes its own cycle_start, preflight, round_start,
//	round_done and cycle_done (documented there).
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
	// onBroken, when set, runs once the stream has failed (EPIPE: the reader went away). It runs
	// under mu, so it must not call back into the writer. -mode agent uses it to stop the round
	// at the next page, not the next suburb (batch 1 item 5).
	onBroken func()
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
		if e.onBroken != nil {
			e.onBroken()
		}
	}
}

// readyEvent is the child's first event. It is written once its SIGTERM handler is installed
// (runAgent), so the cycle never signals a child that has no handler yet.
type readyEvent struct {
	eventHeader
}

// ready writes the ready event. A nil writer is a no-op.
func (e *crawlEvents) ready() {
	e.emit(func() any { return readyEvent{eventHeader: e.header("ready")} })
}

// startupEvent is a start-up step's start or done: step is probe_auth or warm_probe, stage is start or
// done, and outcome (done only) is ok or an ingest_error code word. Work-driven: it is written when a
// step begins and ends, never on a timer.
type startupEvent struct {
	eventHeader
	Step    string `json:"step"`
	Stage   string `json:"stage"`
	Outcome string `json:"outcome,omitempty"`
}

var startupSteps = map[string]bool{"probe_auth": true, "warm_probe": true}
var startupStages = map[string]bool{"start": true, "done": true}

// startup writes one start-up event. An unknown step or stage is refused; an outcome outside the
// contract's words is written as other.
func (e *crawlEvents) startup(step, stage, outcome string) {
	if !startupSteps[step] || !startupStages[stage] {
		return
	}
	// The contract: outcome appears only when stage is done, and its words depend on the step.
	// probe_auth: ok or an ingest_error code word. warm_probe: warm, cold, unusable or env_broken.
	switch {
	case stage != "done":
		outcome = ""
	case step == "warm_probe":
		if !warmProbeWords[outcome] {
			outcome = "unusable"
		}
	case !ingestCodeWords[outcome]:
		outcome = "other"
	}
	e.emit(func() any {
		return startupEvent{eventHeader: e.header("startup"), Step: step, Stage: stage, Outcome: outcome}
	})
}

// warmProbeOutcome names a warm check's result for the startup event: 0 warm, 5 cold (the Kasada
// stub), 4 unusable, 8 env_broken. Anything else is error.
func warmProbeOutcome(rc int) string {
	switch rc {
	case 0:
		return "warm"
	case 5:
		return "cold"
	case exitCrawlEnvBroken:
		return "env_broken"
	default:
		// 4 (unusable), and any other code the warm check returns: the contract's words for a Chrome
		// that is not warm and not a Kasada stub are unusable.
		return "unusable"
	}
}

// warmProbeWords is the contract's outcome set for a warm_probe startup event.
var warmProbeWords = map[string]bool{"warm": true, "cold": true, "unusable": true, "env_broken": true}

// probeEvent is one ProbeAuth answer: ingest_ok (Probe true), or ingest_error with the
// contract's ingest.probe code word. A probe has no job or source, so it carries neither.
type probeEvent struct {
	eventHeader
	Probe bool   `json:"probe"`
	Code  string `json:"code,omitempty"`
}

// probeResult writes ingest_ok or ingest_error for ProbeAuth. code is one of the contract's
// ingest.probe words, and it is ignored on success.
func (e *crawlEvents) probeResult(ok bool, code string) {
	if ok {
		e.emit(func() any {
			return probeEvent{eventHeader: e.header("ingest_ok"), Probe: true}
		})
		return
	}
	if !ingestCodeWords[code] {
		code = "other"
	}
	e.emit(func() any {
		return probeEvent{eventHeader: e.header("ingest_error"), Probe: true, Code: code}
	})
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

// fetchEvent is one page fetch's answer. Outcome is ok, blocked or error.
type fetchEvent struct {
	eventHeader
	JobID   string `json:"job_id"`
	Source  string `json:"source"`
	Page    int    `json:"page"`
	Outcome string `json:"outcome"`
}

// fetch records one page fetch. Sources outside the enum are dropped, and a page
// number outside 1..maxFetchPage is clamped so a counter can never carry text.
func (e *crawlEvents) fetch(jobID, source string, page int, outcome string) {
	if source != "rea" && source != "domain" {
		return
	}
	if outcome != "ok" && outcome != "blocked" && outcome != "error" {
		return
	}
	if page < 1 {
		page = 1
	}
	if page > maxFetchPage {
		page = maxFetchPage
	}
	e.emit(func() any {
		return fetchEvent{eventHeader: e.header("fetch"), JobID: safeJobID(jobID), Source: source, Page: page, Outcome: outcome}
	})
}

// maxFetchPage bounds the page number a fetch event carries. A sweep never walks this far
// (see sweepSuburbSource's page cap), so the clamp only ever guards the field's shape.
const maxFetchPage = 1000

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
// quarantined is set when the server held the sweep back (it applied nothing).
type ingestOKEvent struct {
	eventHeader
	Probe       bool   `json:"probe"`
	JobID       string `json:"job_id"`
	Source      string `json:"source"`
	Applied     string `json:"applied"`
	Replayed    bool   `json:"replayed"`
	Quarantined bool   `json:"quarantined"`
}

// ingestErrorEvent is one failed ingest push, named by its code word alone.
type ingestErrorEvent struct {
	eventHeader
	Probe bool   `json:"probe"`
	Code  string `json:"code"`
}

// shadowCircuitEvent records shadow switching off for the rest of the process.
type shadowCircuitEvent struct {
	eventHeader
	Failures int `json:"failures"`
}

// ingestCodeWords is the closed set of codes an ingest_error event may carry. Anything
// else is written as "other", so no text from the server can reach the stream.
// ingestCodeWords is the contract's closed set for ingest_error.code. A word outside it is written as
// other, so nothing the server says reaches the stream. ok is in the set because the contract lists it.
var ingestCodeWords = map[string]bool{
	"ok": true, "unauthenticated": true, "permission_denied": true, "unavailable": true,
	"contract": true, "token": true, "invalid_argument": true, "resource_exhausted": true,
	"failed_precondition": true, "already_exists": true, "not_found": true, "unimplemented": true,
	"canceled": true, "internal": true, "deadline_exceeded": true, "transport": true,
	"unknown": true, "other": true,
}

// ingestOK writes one ingest_ok event. A nil writer is a no-op.
func (e *crawlEvents) ingestOK(jobID, source, applied string, replayed, quarantined bool) {
	e.emit(func() any {
		return ingestOKEvent{
			eventHeader: e.header("ingest_ok"), Probe: false, JobID: safeJobID(jobID), Source: sourceEnum(source),
			Applied:     enumOrEmpty(applied, map[string]bool{"complete": true, "partial": true, "blocked": true}),
			Replayed:    replayed,
			Quarantined: quarantined,
		}
	})
}

// ingestError writes one ingest_error event.
func (e *crawlEvents) ingestError(code string) {
	if !ingestCodeWords[code] {
		code = "other"
	}
	e.emit(func() any {
		return ingestErrorEvent{eventHeader: e.header("ingest_error"), Probe: false, Code: code}
	})
}

// shadowCircuit writes the one shadow_circuit event.
func (e *crawlEvents) shadowCircuit(failures int) {
	e.emit(func() any {
		return shadowCircuitEvent{eventHeader: e.header("shadow_circuit"), Failures: failures}
	})
}
