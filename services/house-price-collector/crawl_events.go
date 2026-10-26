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
