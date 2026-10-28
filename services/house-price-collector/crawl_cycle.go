package main

// crawl_cycle.go is `-mode cycle` (S2): the Go twin of the bash drain
// (deploy/housing-crawl-common.sh hc_drain_rounds) and the rig-side entry point that
// BrandBrain's runtime spawns. It runs only with CRAWL_SINK=ingest. A cycle holds no
// database. It runs each drain round as a CHILD `-mode agent` in its own process group,
// reads the child's events on a pipe, and decides what happens next from the child's EVENTS
// and EXIT CODE. It never parses log text.
//
// The output contract is docs/superpowers/specs/2026-10-27-fleet-managed-housing-crawl-design.md
// ("Cycle output contract (schema 1)"). Its summary, its outcomes and its events are the
// names used here. golden_contract_test.go pins them.
//
// Jobs:
//
//	drain      lock, preflight (driver, Chrome, ProbeAuth), then child rounds until the queue is
//	           empty, a budget ends the run, or a round asks for a stop.
//	repair     lock, forced install-driver, Chrome warm, warmcheck, with the wedged-Chrome
//	           recovery when the warm check fails or stalls.
//	preflight  NON-mutating and lock-free. It reports health in the summary and exits 0
//	           whenever its checks ran. It claims nothing and installs nothing.
//
// Process rules (batch 1 of the review):
//   - the cycle's own control decisions never wait on its events fd: events go through a
//     bounded queue with one writer goroutine, and a full queue drops forwarded events and
//     counts the drops;
//   - a graceful stop is ONE SIGTERM, to the child PID only, and only once the child has
//     reported "ready" (its handler is installed). The process group gets a signal only for
//     the hung kill and for the second-signal escalation;
//   - every preflight and repair step runs under its own timeout and under the cycle's
//     context, so a deadline or a signal ends it at once.

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"regexp"
	"runtime"
	"runtime/debug"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	pb "github.com/castlemilk/shorted.com.au/services/gen/proto/go/housingingest/v1"
	"github.com/castlemilk/shorted.com.au/services/pkg/housingingest"
)

// cycleSchema is the output contract's schema version. Both sides refuse another value.
const cycleSchema = 1

// The jobs. -job takes exactly one.
const (
	cycleJobDrain     = "drain"
	cycleJobRepair    = "repair"
	cycleJobPreflight = "preflight"
)

// The outcomes, from the contract's closed sets.
const (
	outQueueEmpty      = "queue_empty"
	outBudget          = "budget"
	outNoProgress      = "no_progress"
	outMaxRounds       = "max_rounds"
	outCancelled       = "cancelled"
	outLockHeld        = "lock_held"
	outPreflightFailed = "preflight_failed"
	outStopped         = "stopped"
	outHung            = "hung"
	outInternal        = "internal_error"
	outRepaired        = "repaired"
	outRepairFailed    = "repair_failed"
	outChecked         = "checked"
)

// Exit codes the cycle adds to the design table. 11 and 1 are defined in the design doc.
const (
	exitCycleHung     = 11
	exitCycleInternal = 1
)

// Defaults. The bash drain's names and values are kept for the re-warm policy.
const (
	defaultDrainMaxRounds   = 30
	defaultNoProgressRounds = 3
	defaultRewarmCooldown   = 900 * time.Second
	defaultRewarmBudget     = 2
	defaultHungGrace        = 60 * time.Second
	defaultMaxDuration      = 10 * time.Hour
	defaultInstallTimeout   = 6 * time.Minute
	defaultProbeTimeout     = 4 * time.Minute
	// hungFloor is the least CRAWL_HUNG_AFTER ever gets. The runtime's watchdog is 30 minutes
	// (max(last_event + 30m, cooldown_until + 5m)), so the child must go hung below that.
	hungFloor        = 20 * time.Minute
	cycleSigKillWait = 5 * time.Second
	// parentCheckInterval is how often a supervising cycle checks its parent (batch 3). On darwin
	// there is no Pdeathsig, so a dead runtime is seen as a PPID of 1 at the next check.
	parentCheckInterval     = 1 * time.Second
	cycleEventDrainWait     = 5 * time.Second
	cycleGroupPollInterval  = 25 * time.Millisecond
	cycleEventPumpCapacity  = 4096
	cycleEventPumpCloseWait = 2 * time.Second
	// cycleChildEventsFDValue is the fd the child reads its events on. exec puts the pipe there
	// through ExtraFiles, so it is always fd 3 in the child.
	cycleChildEventsFDValue = "3"
	// cycleDriverDirRel is the driver directory the bash wrapper uses
	// (deploy/housing-crawl-common.sh), relative to $HOME. -mode cycle defaults to it.
	cycleDriverDirRel = ".shorted-housing-crawl/pw-driver"
)

// The contract's closed sets for lock, driver, chrome and ingest.probe.
const (
	lockFree          = "free"
	lockHeldByCycle   = "held_by_cycle"
	lockHeldElsewhere = "held_elsewhere"
	lockUnknown       = "unknown"
)

// cycleIDPattern admits the IDs the cycle accepts from CRAWL_CYCLE_ID: bounded, no free text.
var cycleIDPattern = regexp.MustCompile(`^[A-Za-z0-9._-]{1,64}$`)

var (
	// errStepStopped: a signal or the deadline ended a step before it returned.
	errStepStopped = errors.New("cycle step stopped by a signal or the deadline")
	// errStepHung: a step outlived its timeout (the watchdog's hang).
	errStepHung = errors.New("cycle step hung past its timeout")
	// errStepPanicked: a step panicked. The cycle maps it to internal_error, exit 1.
	errStepPanicked = errors.New("cycle step panicked")
)

// cycleConfig is the policy a cycle runs under. loadCycleConfig fills it from the environment.
type cycleConfig struct {
	stepGrace        time.Duration
	readyWait        time.Duration
	warmTimeout      time.Duration
	job              string
	dryRun           bool
	maxDuration      time.Duration
	maxRounds        int
	noProgressRounds int
	rewarmCooldown   time.Duration
	rewarmBudget     int
	hungAfter        time.Duration
	hungGrace        time.Duration
	installTimeout   time.Duration
	installLockWait  time.Duration
	chromeTimeout    time.Duration
	probeTimeout     time.Duration
	lockDir          string
	cycleID          string
	// childArgv names the child process. Nil runs this binary as `-mode agent`. The tests point
	// it at the test binary, which runs as a fake child (crawl_cycle_fake_test.go).
	childArgv func() (string, []string)
	// workloadSecret is BRANDBRAIN_WORKLOAD_TOKEN_SECRET, read once at entry. It authenticates
	// the cycle's token mints and is handed to each child round, and it is never logged, put in
	// an event or summary, or left in this process's environment.
	workloadSecret string
}

// probeResult is one ProbeAuth answer: the exit code the S-FETCH mapping gives it, and the
// contract word for ingest.probe.
type probeResult struct {
	code int
	word string
}

// chromeResult is the Chrome warm step's answer: the state word and its exit code.
type chromeResult struct {
	state string
	code  int
}

// cycleDeps is every edge the cycle touches that the tests replace with a fake.
type cycleDeps struct {
	driverPresent   func() error
	installDriver   func() int
	ensureChrome    func(ctx context.Context) (string, int)
	chromeReachable func() string
	recoverChrome   func() error
	probeIngest     func(ctx context.Context) (int, string)
	warmcheck       func(ctx context.Context) int
	reportGap       func(cycleID, outcome string, exit int)
	stdout          io.Writer
	events          *crawlEvents
	now             func() time.Time
	// sigs is the injected signal channel. Nil means SIGTERM and SIGINT via signal.Notify.
	sigs <-chan os.Signal
	// exit ends the process after a forced (second-signal) exit. Nil means os.Exit.
	exit func(int)
}

// cycleCounts is the contract's counts object. Every field is a count.
type cycleCounts struct {
	Claimed       int `json:"claimed"`
	Succeeded     int `json:"succeeded"`
	Failed        int `json:"failed"`
	Deferred      int `json:"deferred"`
	Blocked       int `json:"blocked"`
	Pushed        int `json:"pushed"`
	PushFailed    int `json:"push_failed"`
	Quarantined   int `json:"quarantined"`
	EventsDropped int `json:"events_dropped"`
}

// cycleCollector is the build revision, as `-mode version` reports it.
type cycleCollector struct {
	Revision string `json:"revision"`
	Modified bool   `json:"modified"`
}

// cycleEnvSummary is the summary's env object.
type cycleEnvSummary struct {
	Driver string `json:"driver"`
	Chrome string `json:"chrome"`
}

// cycleIngestSummary is the summary's ingest object.
type cycleIngestSummary struct {
	Probe    string  `json:"probe"`
	LastOKAt *string `json:"last_ok_at"`
}

// cycleSummary is the one stdout line. Its field order is the contract's.
type cycleSummary struct {
	Schema     int                `json:"schema"`
	CycleID    string             `json:"cycle_id"`
	Job        string             `json:"job"`
	DryRun     bool               `json:"dry_run"`
	Outcome    string             `json:"outcome"`
	ExitCode   int                `json:"exit_code"`
	Rounds     int                `json:"rounds"`
	StartedAt  string             `json:"started_at"`
	FinishedAt string             `json:"finished_at"`
	Collector  cycleCollector     `json:"collector"`
	Lock       string             `json:"lock"`
	Env        cycleEnvSummary    `json:"env"`
	Ingest     cycleIngestSummary `json:"ingest"`
	Counts     cycleCounts        `json:"counts"`
}

// cycleRound is what one child round produced, from its events and its exit.
type cycleRound struct {
	eventsDropped int
	round         int
	exit          int
	done          bool // the child's round_done was seen
	hung          bool
	processed     int
	claimed       int
	succeeded     int
	failed        int
	deferred      int
	blocked       int
	pushed        int
	pushFailed    int
	quarantined   int
	needsRewarm   bool
}

// childRoundDone is the child's round_done, read for its counts.
type childRoundDone struct {
	Processed     int  `json:"processed"`
	Succeeded     int  `json:"succeeded"`
	Failed        int  `json:"failed"`
	Deferred      int  `json:"deferred"`
	BlockedSweeps int  `json:"blocked_sweeps"`
	NeedsRewarm   bool `json:"needs_rewarm"`
}

// roundProc is one running child: its process group (pgid == pid), its events and its exit.
// wantTerm and ready are guarded by cycleRunner.mu; termOnce makes the graceful stop once.
type roundProc struct {
	cmd      *exec.Cmd
	pid      int
	pipe     *os.File
	pipeOnce sync.Once
	lines    chan []byte
	quit     chan struct{}
	waitDone chan struct{}

	ready    bool
	wantTerm bool
	termOnce sync.Once
}

// sendTerm is the graceful stop: ONE SIGTERM, to the child PID only. The group is not signalled
// here, so the child's Playwright driver (same group) is not hit while the child finishes its
// suburb.
func (p *roundProc) sendTerm() {
	p.termOnce.Do(func() { _ = syscall.Kill(p.pid, syscall.SIGTERM) })
}

// closePipe closes the read end of the child's events pipe. It runs on every path out of
// supervise, and more than once is harmless.
func (p *roundProc) closePipe() {
	p.pipeOnce.Do(func() { _ = p.pipe.Close() })
}

// eventPump is the cycle's own writer. Control and forwarded events are queued without
// blocking, and one goroutine writes them to the events fd. A full queue drops the event and
// counts it, so a slow reader can never stall supervision.
type eventPump struct {
	onPanic func(any)
	ev      *crawlEvents
	ch      chan func() any
	dropped atomic.Int64
	broken  atomic.Bool
	done    chan struct{}
	mu      sync.RWMutex
	closed  bool
}

func newEventPump(ev *crawlEvents, onPanic func(any)) *eventPump {
	p := &eventPump{ev: ev, ch: make(chan func() any, cycleEventPumpCapacity), done: make(chan struct{}), onPanic: onPanic}
	if ev == nil {
		close(p.done)
		return p
	}
	go p.run()
	return p
}

// run is the single writer. After the stream breaks it keeps draining the queue without writing,
// so offers never back up behind a dead pipe.
func (p *eventPump) run() {
	defer close(p.done)
	defer func() {
		// A writer panic is an internal error: it takes the background path, which writes the
		// summary and exits 1 (batch 5 item 8).
		if r := recover(); r != nil && p.onPanic != nil {
			p.onPanic(r)
		}
	}()
	for build := range p.ch {
		if p.broken.Load() {
			continue
		}
		p.ev.emit(build)
		if p.ev.broken() {
			p.broken.Store(true)
		}
	}
}

// offer queues one event without blocking. It reports whether the event was queued.
func (p *eventPump) offer(build func() any) bool {
	if p == nil || p.ev == nil {
		return true
	}
	p.mu.RLock()
	defer p.mu.RUnlock()
	if p.closed {
		return false
	}
	select {
	case p.ch <- build:
		return true
	default:
		p.dropped.Add(1)
		return false
	}
}

// close stops the writer after it drains what is queued, and waits at most wait for that.
func (p *eventPump) close(wait time.Duration) {
	if p == nil {
		return
	}
	p.mu.Lock()
	if !p.closed {
		p.closed = true
		close(p.ch)
	}
	p.mu.Unlock()
	select {
	case <-p.done:
	case <-time.After(wait):
	}
}

func (p *eventPump) isBroken() bool { return p != nil && p.broken.Load() }

func (p *eventPump) droppedCount() int {
	if p == nil {
		return 0
	}
	return int(p.dropped.Load())
}

// cycleRunner is one cycle. Its fields are guarded by mu, except the atomics and the pump, which
// are safe to touch from the signal goroutine.
type cycleRunner struct {
	inflight int
	cfg      cycleConfig
	deps     cycleDeps
	ctx      context.Context
	cancel   context.CancelFunc
	stop     *stopSignal
	budget   atomic.Bool
	forced   atomic.Bool
	pump     *eventPump
	lock     *crawlLock
	// startPPID is the cycle's parent when it started: the runtime. A PPID of 1 later means that
	// parent has died (checkParent).
	startPPID int

	mu           sync.Mutex
	child        *roundProc
	lockOwned    bool
	preLock      string
	preDriver    string
	preChrome    string
	preProbe     string
	repairSpent  bool
	rewarms      int
	noProgress   int
	rounds       int
	counts       cycleCounts
	lastOK       time.Time
	started      time.Time
	decided      bool
	finalOutcome string
	finalCode    int
}

// newCycleRunner builds a runner. Nothing starts until execute.
func newCycleRunner(cfg cycleConfig, deps cycleDeps) *cycleRunner {
	if deps.now == nil {
		deps.now = time.Now
	}
	if deps.stdout == nil {
		deps.stdout = os.Stdout
	}
	if deps.exit == nil {
		deps.exit = os.Exit
	}
	ctx, cancel := context.WithCancel(context.Background())
	c := &cycleRunner{
		cfg:       cfg,
		deps:      deps,
		ctx:       ctx,
		cancel:    cancel,
		stop:      newStopSignal(),
		startPPID: os.Getppid(),
		preLock:   lockUnknown,
		preDriver: lockUnknown,
		preChrome: lockUnknown,
		preProbe:  "not_run",
	}
	c.pump = newEventPump(deps.events, func(r any) {
		log.Printf("[cycle] internal error (event writer panic): %v", r)
		go c.backgroundPanic()
	})
	return c
}

// loadCycleConfig reads the cycle's policy from the environment. validateCycleEnv has already
// refused any value it cannot use, so the defaults here only cover unset variables.
//
// The hung threshold is derived from the page budget, as the design doc's arithmetic shows.
func loadCycleConfig(getenv func(string) string) cycleConfig {
	grace := cycleEnvDuration(getenv, "CRAWL_HUNG_GRACE", defaultHungGrace)
	cfg := cycleConfig{
		maxRounds:        cycleEnvInt(getenv, "CRAWL_DRAIN_MAX_ROUNDS", defaultDrainMaxRounds),
		noProgressRounds: cycleEnvInt(getenv, "CRAWL_DRAIN_NO_PROGRESS_ROUNDS", defaultNoProgressRounds),
		rewarmCooldown:   time.Duration(cycleEnvInt(getenv, "CRAWL_REWARM_COOLDOWN_SEC", int(defaultRewarmCooldown/time.Second))) * time.Second,
		rewarmBudget:     cycleEnvInt(getenv, "CRAWL_REWARM_MAX_RETRIES", defaultRewarmBudget),
		hungAfter:        derivedHungAfter(getenv),
		hungGrace:        grace,
		installTimeout:   defaultInstallTimeout,
		installLockWait:  defaultInstallTimeout - installLockMargin,
		chromeTimeout:    chromeStepTimeout(getenv),
		warmTimeout:      warmProbeWorst(getenv),
		probeTimeout:     defaultProbeTimeout,
		stepGrace:        defaultStepGrace,
		readyWait:        defaultReadyWait,
		lockDir:          defaultCrawlLockDir(),
	}
	if raw := strings.TrimSpace(getenv("CRAWL_HUNG_AFTER")); raw != "" {
		if d, err := time.ParseDuration(raw); err == nil && d > 0 {
			cfg.hungAfter = d
		}
	}
	// Every bound that can outlive the runtime's watchdog is clamped (batch 6, 3): the whole Chrome step
	// and one warm probe.
	cfg.chromeTimeout = clampToCeiling("the Chrome step", cfg.chromeTimeout, grace, &chromeClampOnce)
	cfg.warmTimeout = clampToCeiling("one warm probe", cfg.warmTimeout, grace, &warmClampOnce)
	// Explicit and derived values are both bounded (batch 5 item 9).
	cfg.hungAfter = clampHungAfter(cfg.hungAfter, grace, &hungClampOnce)
	if cfg.maxRounds <= 0 {
		cfg.maxRounds = defaultDrainMaxRounds
	}
	if cfg.rewarmBudget < 0 {
		cfg.rewarmBudget = 0
	}
	if id := strings.TrimSpace(getenv("CRAWL_CYCLE_ID")); id != "" && cycleIDPattern.MatchString(id) {
		cfg.cycleID = id
	} else {
		cfg.cycleID = newCycleID()
	}
	return cfg
}

// derivedHungAfter is the child's silence limit when CRAWL_HUNG_AFTER is unset.
//
// The longest legitimate silence is one page's worth of work, with no event in between:
//
//	fetch timeout            CRAWL_FETCH_TIMEOUT_S         default 60 s
//	+ pace, at widest        3 x CRAWL_LISTINGS_PAGE_MAX_MS  3 x 20 s = 60 s
//	+ push, all attempts     3 x ingestCallTimeout         3 x 60 s = 180 s
//	+ push backoff           1 s + 2 s                     = 3 s
//	= worst single page      303 s
//	x 2 (margin)             606 s, about 10 minutes
//
// The floor is 20 minutes, so the default is 20 minutes. A slower fetch config raises it.
// The runtime's 30-minute watchdog stays above the result.
// derivedHungAfter is the child's silence limit when CRAWL_HUNG_AFTER is unset: the worst silence
// (cycleSilenceWorst), and never below the 20-minute floor. The clamp in loadCycleConfig applies on top.
func derivedHungAfter(getenv func(string) string) time.Duration {
	if w := cycleSilenceWorst(getenv); w > hungFloor {
		return w
	}
	return hungFloor
}

func cycleEnvInt(getenv func(string) string, key string, def int) int {
	raw := strings.TrimSpace(getenv(key))
	if raw == "" {
		return def
	}
	n, err := strconv.Atoi(raw)
	if err != nil {
		return def
	}
	return n
}

func cycleEnvDuration(getenv func(string) string, key string, def time.Duration) time.Duration {
	raw := strings.TrimSpace(getenv(key))
	if raw == "" {
		return def
	}
	d, err := time.ParseDuration(raw)
	if err != nil || d <= 0 {
		return def
	}
	return d
}

// validateCycleEnv refuses a value the cycle cannot run with, so the cycle exits 8 with a clear
// message instead of quietly using a default. Unset is fine.
func validateCycleEnv(getenv func(string) string) error {
	for _, key := range []string{"CRAWL_DRAIN_MAX_ROUNDS", "CRAWL_DRAIN_NO_PROGRESS_ROUNDS"} {
		raw := strings.TrimSpace(getenv(key))
		if raw == "" {
			continue
		}
		n, err := strconv.Atoi(raw)
		if err != nil || n <= 0 {
			return fmt.Errorf("%s must be a positive integer (got %q)", key, raw)
		}
	}
	if raw := strings.TrimSpace(getenv("CRAWL_HUNG_AFTER")); raw != "" {
		if d, err := time.ParseDuration(raw); err != nil || d <= 0 {
			return fmt.Errorf("CRAWL_HUNG_AFTER must be a positive duration (got %q)", raw)
		}
	}
	// The hung kill waits this long between SIGTERM and SIGKILL. Too short and a slow group never empties;
	// too long and the ceiling (the 30 m watchdog less grace and drain) shrinks towards zero (batch 6, 4).
	if raw := strings.TrimSpace(getenv("CRAWL_HUNG_GRACE")); raw != "" {
		d, err := time.ParseDuration(raw)
		if err != nil || d < minHungGrace || d > maxHungGrace {
			return fmt.Errorf("CRAWL_HUNG_GRACE must be between %s and %s (got %q)", minHungGrace, maxHungGrace, raw)
		}
	}
	return nil
}

// newCycleID returns a fresh, bounded cycle id.
func newCycleID() string {
	var b [6]byte
	if _, err := rand.Read(b[:]); err != nil {
		return fmt.Sprintf("cyc-%d", time.Now().UnixNano())
	}
	return "cyc-" + hex.EncodeToString(b[:])
}

// defaultChildArgv is this binary as `-mode agent`.
func defaultChildArgv() (string, []string) {
	exe, err := os.Executable()
	if err != nil {
		exe = os.Args[0]
	}
	return exe, []string{"-mode", "agent"}
}

// cycleDefaultDriverDir is the driver directory -mode cycle uses when CRAWL_PW_DRIVER_DIR is
// unset: the bash wrapper's own directory, never a cache a sweep can empty.
func cycleDefaultDriverDir() string {
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return ""
	}
	return filepath.Join(home, cycleDriverDirRel)
}

// applyCycleDriverDefault sets CRAWL_PW_DRIVER_DIR for a cycle when the environment leaves it
// unset. It returns the directory now in force. Only -mode cycle calls it: the other modes keep
// the playwright default, which BrandBrain's Swift-timer path relies on.
func applyCycleDriverDefault(getenv func(string) string, setenv func(k, v string) error) string {
	if cur := strings.TrimSpace(getenv("CRAWL_PW_DRIVER_DIR")); cur != "" {
		return cur
	}
	dir := cycleDefaultDriverDir()
	if dir != "" {
		_ = setenv("CRAWL_PW_DRIVER_DIR", dir)
	}
	return dir
}

// runCycleMode is the `-mode cycle` entry point. Every path prints the one summary line, refusals
// and bad configuration included. dryRun is the -dry-run flag OR CRAWL_DRY_RUN=true.
func runCycleMode(stdout io.Writer, job string, dryRunFlag bool, maxDuration time.Duration, getenv func(string) string, events *crawlEvents) int {
	cfg := loadCycleConfig(getenv)
	// The workload secret is read here and only here, then scrubbed from this process's
	// environment: the cycle's own helper processes inherit the environment and must not get it.
	acfg := loadCycleAgentConfig(getenv)
	cfg.workloadSecret = acfg.workloadSecret
	scrubWorkloadSecret()
	cfg.job = job
	cfg.dryRun = resolveCycleDryRun(dryRunFlag, getenv)
	cfg.maxDuration = maxDuration

	deps := cycleDeps{
		driverPresent:   checkPlaywrightDriver,
		installDriver:   func() int { return runInstallDriverWait(false, cfg.installLockWait) },
		chromeReachable: defaultChromeReachable,
		recoverChrome:   defaultRecoverChrome,
		stdout:          stdout,
		events:          events,
		now:             time.Now,
	}

	switch job {
	case cycleJobDrain, cycleJobRepair, cycleJobPreflight:
	default:
		return refuseCycle(deps, cfg, "-job must be drain, repair or preflight")
	}
	if maxDuration <= 0 {
		return refuseCycle(deps, cfg, fmt.Sprintf("-max-duration must be positive (got %s)", maxDuration))
	}
	if err := validateCycleEnv(getenv); err != nil {
		return refuseCycle(deps, cfg, err.Error())
	}
	// The cycle runs only on the ingest sink. resolveSink does the full validation (the pinned URL,
	// no DATABASE_URL, an explicit CRAWL_DRY_RUN, no gateway, no trace). This adds the refusal of
	// db, shadow and unset.
	sink, ingestURL, refusal := resolveSink("agent", getenv)
	if refusal != "" {
		return refuseCycle(deps, cfg, refusal)
	}
	if sink != crawlSinkIngest {
		return refuseCycle(deps, cfg, fmt.Sprintf("-mode cycle runs only with %s=ingest (got %q)", crawlSinkEnv, sink))
	}
	// Without the workload secret the cycle cannot mint, so it refuses before any probe or lock.
	// The refusal names the variable and never a value. The control secret is not a fallback.
	if cfg.workloadSecret == "" {
		return refuseCycle(deps, cfg, workloadTokenSecretEnv+" is missing or empty: the cycle mints workload tokens with it and never reads the control secret")
	}
	applyCycleDriverDefault(getenv, os.Setenv)

	deps.probeIngest = func(ctx context.Context) (int, string) { return probeIngestDetail(ctx, ingestURL, acfg) }
	deps.reportGap = func(cycleID, outcome string, exit int) { reportGapWith(cycleID, outcome, exit, ingestURL, acfg) }
	c := newCycleRunner(cfg, deps)
	// The Chrome step and the warm check report each warm probe as startup events, and bound each probe
	// separately (batch 6, 3). They need this runner's emitter, so they are bound here.
	c.deps.ensureChrome = func(ctx context.Context) (string, int) { return defaultEnsureChrome(ctx, c.warmProbeOnce) }
	c.deps.warmcheck = c.warmProbeOnce
	return c.execute()
}

// resolveCycleDryRun is the cycle's dry-run decision: the -dry-run flag, or CRAWL_DRY_RUN=true. The
// cycle requires CRAWL_DRY_RUN to be set, and it must also read the value (batch 2 item 1): a value
// of true is a dry run, and the child is told the same.
func resolveCycleDryRun(flag bool, getenv func(string) string) bool {
	return flag || strings.TrimSpace(getenv("CRAWL_DRY_RUN")) == "true"
}

// refuseCycle prints the summary for a configuration refusal. It exits 8, which is the
// invalid-configuration code, and it names the outcome for the job.
func refuseCycle(deps cycleDeps, cfg cycleConfig, reason string) int {
	if !validCycleJob(cfg.job) {
		cfg.job = cycleJobUnknown
	}
	if cfg.cycleID == "" {
		cfg.cycleID = newCycleID()
	}
	log.Printf("[cycle] refusing to start: %s", reason)
	c := newCycleRunner(cfg, deps)
	c.started = c.deps.now()
	c.emitStart()
	return c.finalize(refusalOutcome(cfg.job), exitSinkRefused)
}

// refusalOutcome is the outcome a configuration refusal reports, per job. The repair job's
// failure outcome is repair_failed; the drain and the preflight use preflight_failed.
func refusalOutcome(job string) string {
	if job == cycleJobRepair {
		return outRepairFailed
	}
	return outPreflightFailed
}

// cycleFlagFailure is run when flag parsing fails. A cycle still prints its summary (exit 8).
// Any other mode exits 2, as flag.Parse always has.
func cycleFlagFailure(args []string, stdout io.Writer) int {
	if !argsAreCycle(args) {
		return 2
	}
	job := cycleJobDrain
	for i, a := range args {
		if (a == "-job" || a == "--job") && i+1 < len(args) {
			job = args[i+1]
		}
		if strings.HasPrefix(a, "-job=") {
			job = strings.TrimPrefix(a, "-job=")
		}
	}
	deps := cycleDeps{stdout: stdout, events: newCrawlEventsFromEnv(), now: time.Now}
	cfg := loadCycleConfig(os.Getenv)
	cfg.job = job
	return refuseCycle(deps, cfg, "invalid flags for -mode cycle")
}

// argsAreCycle reports whether the arguments select -mode cycle.
func argsAreCycle(args []string) bool {
	for i, a := range args {
		if (a == "-mode" || a == "--mode") && i+1 < len(args) && args[i+1] == "cycle" {
			return true
		}
		if a == "-mode=cycle" || a == "--mode=cycle" {
			return true
		}
	}
	return false
}

// execute runs the job and returns the process exit code. It prints the summary. A panic is
// recovered: the child group is killed, and the summary says internal_error with exit 1.
func (c *cycleRunner) execute() (code int) {
	defer c.cancel()
	defer func() {
		if r := recover(); r != nil {
			log.Printf("[cycle] internal error (panic): %v\n%s", r, debug.Stack())
			c.killChildGroup(syscall.SIGKILL)
			code = c.finalizePanic()
		}
	}()
	c.started = c.deps.now()
	c.emitStart()
	log.Printf("[cycle] %s start: cycle=%s dryRun=%v maxRounds=%d maxDuration=%s hungAfter=%s", c.cfg.job, c.cfg.cycleID, c.cfg.dryRun, c.cfg.maxRounds, c.cfg.maxDuration, c.cfg.hungAfter)

	sigs := c.deps.sigs
	if sigs == nil {
		ch := make(chan os.Signal, 2)
		signal.Notify(ch, syscall.SIGTERM, os.Interrupt)
		defer signal.Stop(ch)
		sigs = ch
	}
	// A dead events pipe must return EPIPE, not kill the cycle.
	signal.Ignore(syscall.SIGPIPE)
	done := make(chan struct{})
	defer close(done)
	go func() {
		defer c.recoverBackground()
		c.watchSignals(sigs, done)
	}()

	if c.cfg.maxDuration > 0 {
		t := time.AfterFunc(c.cfg.maxDuration, func() {
			defer c.recoverBackground()
			log.Printf("[cycle] -max-duration %s reached: no new rounds; the running round is stopped", c.cfg.maxDuration)
			c.budget.Store(true)
			c.cancel()
			c.requestChildTerm()
		})
		defer t.Stop()
	}

	outcome, cd := c.dispatch()
	return c.finalize(outcome, cd)
}

// emitStart writes cycle_start.
func (c *cycleRunner) emitStart() {
	c.emit("cycle_start", map[string]any{
		"job":       c.cfg.job,
		"dry_run":   c.cfg.dryRun,
		"collector": currentCollector(),
	})
}

// dispatch runs the job. Drain and repair take the lock; preflight takes none.
func (c *cycleRunner) dispatch() (string, int) {
	switch c.cfg.job {
	case cycleJobPreflight:
		return c.preflightJob()
	case cycleJobRepair:
		return c.withLock(cycleJobRepair, c.repairJob)
	default:
		return c.withLock(cycleJobDrain, c.drainJob)
	}
}

// withLock takes the single-drainer lock (the lockdir and pid rules of bash) and runs fn under
// it. The cycle must be the holder. A lock held by a live process, including the cycle's own
// parent, is exit 12 and nothing runs (batch 1 item 6).
func (c *cycleRunner) withLock(job string, fn func() (string, int)) (string, int) {
	c.lock = newCrawlLock(c.cfg.lockDir)
	outcome, holder, err := c.lock.acquire()
	switch outcome {
	case lockHeld:
		c.setPre(func() { c.preLock = lockHeldElsewhere })
		if err != nil {
			log.Printf("[cycle] skipped: %v — claiming nothing (exit %d)", err, exitLockHeld)
		} else {
			log.Printf("[cycle] skipped: lock held by pid %d (%s) — another housing crawl is draining (exit %d)", holder, c.cfg.lockDir, exitLockHeld)
		}
		return outLockHeld, exitLockHeld
	case lockPassthrough:
		c.setPre(func() { c.preLock = lockHeldElsewhere })
		log.Printf("[cycle] lock held by parent pid %d — the cycle must be the holder, not a passenger (exit %d)", holder, exitLockHeld)
		return outLockHeld, exitLockHeld
	case lockError:
		c.setPre(func() { c.preLock = lockUnknown })
		log.Printf("[cycle] FATAL: cannot create the housing-crawl lock at %s (%v) — exit %d", c.cfg.lockDir, err, exitAgentInfra)
		if job == cycleJobRepair {
			return outRepairFailed, exitAgentInfra
		}
		return outPreflightFailed, exitAgentInfra
	default:
		c.mu.Lock()
		c.lockOwned = true
		c.mu.Unlock()
		c.setPre(func() { c.preLock = lockHeldByCycle })
		defer c.releaseLock()
		return fn()
	}
}

// releaseLock releases the lock once. The forced exit and the normal return both call it.
func (c *cycleRunner) releaseLock() {
	c.mu.Lock()
	owned := c.lockOwned
	c.lockOwned = false
	c.mu.Unlock()
	if owned && c.lock != nil {
		c.lock.release()
	}
}

// inspectLock reads the lock without changing it, and returns the contract's lock value. A
// stale lock (a pid that is no longer alive, or an unreadable pid) is free: a drain could take it.
func inspectLock(dir string) string {
	if _, err := os.Stat(dir); err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return lockFree
		}
		return lockUnknown
	}
	pid, ok := readPidFile(filepath.Join(dir, crawlLockPidName))
	if !ok {
		return lockFree
	}
	if pidAlive(pid) {
		return lockHeldElsewhere
	}
	return lockFree
}

// runStep runs one step under the cycle's context and the step's timeout. A signal or the deadline
// ends the wait at once (errStepStopped). A step that outlives its timeout is errStepHung. The
// step's goroutine may outlive the wait, and it dies with the process.
func runStep[T any](c *cycleRunner, timeout time.Duration, fn func(ctx context.Context) T) (T, error) {
	var zero T
	ctx, cancel := context.WithTimeout(c.ctx, timeout)
	defer cancel()
	done := make(chan T, 1)
	failed := make(chan any, 1)
	go func() {
		// A panic on this goroutine would bypass execute's recover, so it is carried back here.
		defer func() {
			if r := recover(); r != nil {
				failed <- r
			}
		}()
		done <- fn(ctx)
	}()
	select {
	case v := <-done:
		return v, nil
	case r := <-failed:
		log.Printf("[cycle] step panicked: %v\n%s", r, debug.Stack())
		return zero, errStepPanicked
	case <-c.ctx.Done():
		return zero, errStepStopped
	case <-ctx.Done():
		// The step's own deadline. A step that honours its context answers with its real code
		// within the grace, and that code is the answer. Only a step still silent after the grace
		// is hung (batch 4 item 2).
		grace := time.NewTimer(c.cfg.stepGrace)
		defer grace.Stop()
		select {
		case v := <-done:
			return v, nil
		case r := <-failed:
			log.Printf("[cycle] step panicked after its deadline: %v\n%s", r, debug.Stack())
			return zero, errStepPanicked
		case <-c.ctx.Done():
			return zero, errStepStopped
		case <-grace.C:
			return zero, errStepHung
		}
	}
}

// stopOutcome is the outcome of a stop, for a drain: a signal is cancelled (10), and the
// deadline is budget (0).
func (c *cycleRunner) stopOutcome() (string, int) {
	if c.stop.Reason() == "" && c.budget.Load() {
		return outBudget, 0
	}
	return outCancelled, exitCrawlCancelled
}

// drainPreflight runs the drain's checks in order: the driver (installed once if missing),
// Chrome warm, and ProbeAuth. It returns ok=false with the failing outcome and code.
func (c *cycleRunner) drainPreflight() (string, int, bool) {
	c.phase("preflight", nil)
	code, err := c.ensureDriver()
	if out, cd, bad := c.drainStepFailure(code, err); bad {
		return out, cd, false
	}
	c.phase("preflight", nil)
	cr, err := runStep(c, c.cfg.chromeTimeout, func(ctx context.Context) chromeResult {
		st, rc := c.deps.ensureChrome(ctx)
		return chromeResult{state: st, code: rc}
	})
	if err == nil {
		c.setPre(func() { c.preChrome = chromeWord(cr.state) })
	}
	if out, cd, bad := c.drainStepFailure(cr.code, err); bad {
		return out, cd, false
	}
	c.phase("preflight", nil)
	code, err = c.probeStep()
	if out, cd, bad := c.drainStepFailure(code, err); bad {
		return out, cd, false
	}
	return "", 0, true
}

// drainStepFailure maps a step's code or error to the drain's outcome. It reports bad=false for
// a step that passed.
func (c *cycleRunner) drainStepFailure(code int, err error) (string, int, bool) {
	switch {
	case errors.Is(err, errStepStopped):
		o, cd := c.stopOutcome()
		return o, cd, true
	case errors.Is(err, errStepHung):
		return outHung, exitCycleHung, true
	case errors.Is(err, errStepPanicked):
		return outInternal, exitCycleInternal, true
	case err != nil:
		return outInternal, exitCycleInternal, true
	case code != 0:
		return outPreflightFailed, code, true
	}
	return "", 0, false
}

// chromeWord maps the warm step's state onto the contract's chrome value. not_used and skipped
// are not a Chrome answer, so they are unknown.
func chromeWord(state string) string {
	switch state {
	case "warm":
		return "warm"
	case "unusable", "env_broken":
		return "unusable"
	default:
		return lockUnknown
	}
}

// checkDriverPresent runs the driver check under the install timeout. It installs nothing and
// creates nothing.
func (c *cycleRunner) checkDriverPresent() (bool, error) {
	rc, err := runStep(c, c.cfg.installTimeout, func(context.Context) int {
		if c.deps.driverPresent() != nil {
			return 1
		}
		return 0
	})
	return rc == 0, err
}

// ensureDriver is the drain's driver step: present is ok, missing is installed once per cycle,
// and a second miss is exit 8.
func (c *cycleRunner) ensureDriver() (int, error) {
	present, err := c.checkDriverPresent()
	if err != nil {
		c.setPre(func() { c.preDriver = lockUnknown })
		return 0, err
	}
	if present {
		c.setPre(func() { c.preDriver = "ok" })
		return 0, nil
	}
	c.mu.Lock()
	spent := c.repairSpent
	c.repairSpent = true
	c.mu.Unlock()
	if spent {
		c.setPre(func() { c.preDriver = "missing" })
		return exitCrawlEnvBroken, nil
	}
	ok, err := c.installDriverStep()
	if err != nil {
		c.setPre(func() { c.preDriver = lockUnknown })
		return 0, err
	}
	if !ok {
		c.setPre(func() { c.preDriver = "missing" })
		return exitCrawlEnvBroken, nil
	}
	c.setPre(func() { c.preDriver = "installed" })
	return 0, nil
}

// installDriverStep runs install-driver under its timeout, then checks that the driver runs.
func (c *cycleRunner) installDriverStep() (bool, error) {
	c.phase("install_driver", nil)
	log.Printf("[cycle] installing the playwright driver (install-driver)")
	rc, err := runStep(c, c.cfg.installTimeout, func(context.Context) int { return c.deps.installDriver() })
	if err != nil {
		return false, err
	}
	if rc != 0 {
		return false, nil
	}
	return c.checkDriverPresent()
}

// probeStep runs ProbeAuth under its timeout and writes its ingest event. The code is the S-FETCH
// mapping (13, 14, 15, 8, 7). A stalled probe is "unavailable" in the summary.
func (c *cycleRunner) probeStep() (int, error) {
	pr, err := runStep(c, c.cfg.probeTimeout, func(ctx context.Context) probeResult {
		code, word := c.deps.probeIngest(ctx)
		return probeResult{code: code, word: word}
	})
	if err != nil {
		c.setPre(func() { c.preProbe = "unavailable" })
		return 0, err
	}
	if pr.code == 0 {
		c.setPre(func() { c.preProbe = "ok" })
		c.noteOK()
		c.emit("ingest_ok", map[string]any{"probe": true})
		return 0, nil
	}
	word := contractProbeCode(pr.word)
	c.setPre(func() { c.preProbe = summaryProbeWord(word) })
	c.emit("ingest_error", map[string]any{"probe": true, "code": word})
	return pr.code, nil
}

// drainJob is the preflight and then the rounds. A preflight failure that leaves ingest reachable
// (4, 8 or 15) reports once at cycle level, because the runtime sees it as bash did.
func (c *cycleRunner) drainJob() (string, int) {
	c.checkParent()
	if c.stopRequested() {
		return outCancelled, exitCrawlCancelled
	}
	c.phase("preflight", nil)
	out, code, ok := c.drainPreflight()
	c.emitPreflight()
	if !ok {
		if code == 4 || code == 8 || code == 15 {
			c.report("failed", code)
		}
		return out, code
	}
	return c.drainRounds()
}

// checkParent is the cycle's parent check. When the runtime that spawned the cycle has died, the
// PPID becomes 1 and the cycle behaves as on SIGTERM: the round finishes its suburb, then the cycle
// exits 10 (the contract's "Parent death"). It runs at each round boundary and at each child event,
// so it is driven by work, not by a timer.
func (c *cycleRunner) checkParent() {
	if c.startPPID != 1 && os.Getppid() == 1 {
		log.Printf("[cycle] the runtime that spawned this cycle has exited — stopping after the current suburb")
		c.requestStop("orphaned")
	}
}

// drainRounds runs child rounds until a stop, a budget or the queue is empty. Each decision is
// made on a round's events and exit code, never on log text.
func (c *cycleRunner) drainRounds() (string, int) {
	for {
		c.checkParent()
		if c.stop.Reason() != "" {
			return outCancelled, exitCrawlCancelled
		}
		if c.budget.Load() {
			return outBudget, 0
		}
		c.mu.Lock()
		rounds := c.rounds
		c.mu.Unlock()
		if rounds >= c.cfg.maxRounds {
			log.Printf("[cycle] hit CRAWL_DRAIN_MAX_ROUNDS=%d — stopping (the queue may still hold work)", c.cfg.maxRounds)
			return outMaxRounds, 0
		}
		if c.cfg.dryRun && rounds >= 1 {
			// A dry round submits nothing, so the queue never drains. One round is the most a dry
			// run can usefully say, and max_rounds is the contract's word for that stop.
			log.Printf("[cycle] dry run: one round, then stop")
			return outMaxRounds, 0
		}
		c.mu.Lock()
		c.rounds++
		round := c.rounds
		c.mu.Unlock()

		res := c.runRound(round)
		c.addCounts(res)
		if out, code, next := c.decide(res); !next {
			return out, code
		}
	}
}

// decide maps one round's result to the drain's next step. It is ordered on purpose: a
// hang, then a pending signal, then the budget, then the child's exit code. So a stop that is
// already pending never starts a repair or a cooldown (batch 2 item 2).
func (c *cycleRunner) decide(res cycleRound) (string, int, bool) {
	if res.hung {
		return outHung, exitCycleHung, false
	}
	if c.stop.Reason() != "" {
		return outCancelled, exitCrawlCancelled, false
	}
	code := res.exit
	budget := c.budget.Load()
	// At -max-duration, a clean or routine code ends the run as budget. A worse code is kept.
	if budget && (code == 0 || code == exitCrawlCancelled) {
		return outBudget, 0, false
	}
	switch code {
	case 0:
		if !res.done {
			log.Printf("[cycle] round exited 0 without a round_done event: protocol fault")
			return outInternal, exitCycleInternal, false
		}
		if res.claimed == 0 && res.processed == 0 {
			return outQueueEmpty, 0, false
		}
		c.mu.Lock()
		if res.succeeded == 0 {
			c.noProgress++
		} else {
			c.noProgress = 0
		}
		streak := c.noProgress
		c.mu.Unlock()
		if streak >= c.cfg.noProgressRounds {
			log.Printf("[cycle] %d consecutive rounds with no succeeded job — stopping (no_progress); the runtime alarms on it", streak)
			return outNoProgress, 0, false
		}
		return "", 0, true
	case 3, 5:
		if budget {
			// Budget applies only to a child code of 0 or 10 (contract). A routine re-warm code is kept,
			// and no cooldown runs at the deadline: the runtime owns the 2 h backoff.
			return outStopped, code, false
		}
		// The bash drain's measured policy, carried over. A re-warm is a routine Kasada outcome,
		// and the cooldown is what lets a retry work. The budget is what stops a blocking portal
		// being hammered: 2 retries measured best (2026-09-11), and more retries against an open
		// circuit only asked the blocking portal again.
		c.mu.Lock()
		spent := c.rewarms >= c.cfg.rewarmBudget
		if !spent {
			c.rewarms++
		}
		retry := c.rewarms
		last := c.rounds >= c.cfg.maxRounds
		c.mu.Unlock()
		if spent {
			log.Printf("[cycle] re-warm signalled (rc=%d) and the retry budget is spent after %d retry(ies) — stopping", code, c.cfg.rewarmBudget)
			return outStopped, code, false
		}
		log.Printf("[cycle] re-warm signalled (rc=%d) — cooling down %s then retrying (%d/%d)", code, c.cfg.rewarmCooldown, retry, c.cfg.rewarmBudget)
		// No cooldown after the last round the cycle may run: the loop ends there anyway.
		if !last {
			c.cooldown(c.cfg.rewarmCooldown)
		}
		return "", 0, true
	case exitCrawlEnvBroken:
		// A pending stop or budget keeps the repair out: the stop wins. Otherwise install once, then
		// retry the round once (the install is shared with the preflight, so a driver the preflight
		// already repaired is not installed twice).
		if budget {
			return outStopped, exitCrawlEnvBroken, false
		}
		c.mu.Lock()
		spent := c.repairSpent
		c.repairSpent = true
		c.mu.Unlock()
		if spent {
			return outStopped, exitCrawlEnvBroken, false
		}
		ok, err := c.installDriverStep()
		if err != nil {
			o, cd := c.stepOutcome(err)
			return o, cd, false
		}
		if !ok {
			return outStopped, exitCrawlEnvBroken, false
		}
		return "", 0, true
	case exitCrawlCancelled:
		return outCancelled, exitCrawlCancelled, false
	case 4, 7, 12, 13, 14, 15:
		return outStopped, code, false
	default:
		// A child code the table does not know: internal, exit 1 (contract: "exit 1 ... a child
		// exit code the table doesn't know").
		log.Printf("[cycle] round exited with code %d, which the table does not know — exit %d", code, exitCycleInternal)
		return outInternal, exitCycleInternal, false
	}
}

// stepOutcome maps a step error to an outcome: a stop, or a hang.
func (c *cycleRunner) stepOutcome(err error) (string, int) {
	if errors.Is(err, errStepHung) {
		return outHung, exitCycleHung
	}
	return c.stopOutcome()
}

// cooldown waits d. A signal or the deadline ends it early.
func (c *cycleRunner) cooldown(d time.Duration) {
	if d <= 0 {
		return
	}
	c.checkParent()
	if c.stopRequested() {
		return
	}
	until := c.deps.now().Add(d)
	c.phase("cooldown", &until)
	t := time.NewTimer(d)
	defer t.Stop()
	// The cooldown polls the parent too: a runtime that dies during a multi-hour cooldown is seen
	// within parentCheckInterval, and the cooldown ends at once.
	poll := time.NewTicker(parentCheckInterval)
	defer poll.Stop()
	for {
		select {
		case <-t.C:
			return
		case <-c.ctx.Done():
			return
		case <-poll.C:
			c.checkParent()
		}
	}
}

// repairJob forces the driver install, warms Chrome and runs the warm check. When the check fails
// or stalls it runs the wedged-Chrome recovery (the path rc 4 uses) and checks once more.
func (c *cycleRunner) repairJob() (string, int) {
	c.checkParent()
	if c.stopRequested() {
		return outCancelled, exitCrawlCancelled
	}
	c.phase("repair", nil)
	defer c.emitPreflight()
	ok, err := c.installDriverStep()
	if err != nil {
		return c.repairFailure(err, exitCrawlEnvBroken)
	}
	if !ok {
		c.setPre(func() { c.preDriver = "missing" })
		return outRepairFailed, exitCrawlEnvBroken
	}
	c.setPre(func() { c.preDriver = "installed" })
	c.phase("repair", nil)
	cr, err := runStep(c, c.cfg.chromeTimeout, func(ctx context.Context) chromeResult {
		st, rc := c.deps.ensureChrome(ctx)
		return chromeResult{state: st, code: rc}
	})
	if err != nil {
		return c.repairFailure(err, 0)
	}
	c.setPre(func() { c.preChrome = chromeWord(cr.state) })
	if cr.code != 0 {
		return outRepairFailed, cr.code
	}
	return c.warmGate()
}

// warmGate is the repair's warm check and recovery.
func (c *cycleRunner) warmGate() (string, int) {
	c.phase("repair", nil)
	rc, err := c.warmStep()
	if err == nil && rc == 0 {
		c.setPre(func() { c.preChrome = "warm" })
		return outRepaired, 0
	}
	// A stop ends the repair. A stall (errStepHung) or a failed check is recovered below, as the
	// contract requires (batch 1 item 10). Only an env fault is not a Chrome fault.
	if errors.Is(err, errStepStopped) {
		return c.repairFailure(err, 0)
	}
	if err == nil && rc == exitCrawlEnvBroken {
		return outRepairFailed, exitCrawlEnvBroken
	}
	// The warm check failed (rc 4 or 5) or stalled. The wedged-Chrome recovery is the path rc 4
	// uses: kill, clear the profile locks, relaunch. Then one more check.
	log.Printf("[cycle] warm check rc=%d — running the wedged-Chrome recovery, then checking again", rc)
	c.phase("repair", nil)
	rr, err := runStep(c, c.cfg.chromeTimeout, func(context.Context) int {
		if c.deps.recoverChrome() != nil {
			return 4
		}
		return 0
	})
	if err != nil {
		return c.repairFailure(err, 0)
	}
	if rr != 0 {
		c.setPre(func() { c.preChrome = "unusable" })
		return outRepairFailed, 4
	}
	rc, err = c.warmStep()
	if err == nil && rc == 0 {
		c.setPre(func() { c.preChrome = "warm" })
		return outRepaired, 0
	}
	if err != nil {
		return c.repairFailure(err, 0)
	}
	c.setPre(func() { c.preChrome = "unusable" })
	if rc == exitCrawlEnvBroken {
		return outRepairFailed, exitCrawlEnvBroken
	}
	return outRepairFailed, 4
}

// warmStep runs warmcheck under the Chrome timeout.
func (c *cycleRunner) warmStep() (int, error) {
	return runStep(c, c.cfg.warmTimeout, func(ctx context.Context) int { return c.deps.warmcheck(ctx) })
}

// repairFailure maps a repair step's error to its outcome: a stop is cancelled, a hang is 11.
func (c *cycleRunner) repairFailure(err error, code int) (string, int) {
	switch {
	case errors.Is(err, errStepStopped):
		o, cd := c.stopOutcome()
		if o == outBudget {
			return outCancelled, exitCrawlCancelled
		}
		return o, cd
	case errors.Is(err, errStepHung):
		return outRepairFailed, exitCycleHung
	case errors.Is(err, errStepPanicked):
		// The repair outcome set has no internal_error; the panic is still exit 1 (flagged in the report).
		return outInternal, exitCycleInternal
	}
	return outRepairFailed, code
}

// preflightJob is the NON-mutating check. It takes no lock, claims nothing and installs nothing.
// It runs every check and reports each in the summary. Its exit is 0 whenever the checks ran, and
// a stop is the only other exit.
func (c *cycleRunner) preflightJob() (string, int) {
	defer c.emitPreflight()
	c.setPre(func() { c.preLock = inspectLock(c.cfg.lockDir) })

	c.phase("preflight", nil)
	present, err := c.checkDriverPresent()
	switch {
	case errors.Is(err, errStepPanicked):
		return outInternal, exitCycleInternal
	case errors.Is(err, errStepStopped):
		return outCancelled, exitCrawlCancelled
	case err != nil:
		c.setPre(func() { c.preDriver = lockUnknown })
	case present:
		c.setPre(func() { c.preDriver = "ok" })
	default:
		c.setPre(func() { c.preDriver = "missing" })
	}

	c.phase("preflight", nil)
	chrome, err := runStep(c, c.cfg.chromeTimeout, func(context.Context) string { return c.deps.chromeReachable() })
	switch {
	case errors.Is(err, errStepPanicked):
		return outInternal, exitCycleInternal
	case errors.Is(err, errStepStopped):
		return outCancelled, exitCrawlCancelled
	case err != nil:
		c.setPre(func() { c.preChrome = lockUnknown })
	case chrome == "reachable":
		c.setPre(func() { c.preChrome = "reachable" })
	case chrome == "unreachable":
		c.setPre(func() { c.preChrome = "unreachable" })
	default:
		c.setPre(func() { c.preChrome = lockUnknown })
	}

	c.phase("preflight", nil)
	_, err = c.probeStep()
	switch {
	case errors.Is(err, errStepPanicked):
		return outInternal, exitCycleInternal
	case errors.Is(err, errStepStopped):
		return outCancelled, exitCrawlCancelled
	}
	return outChecked, 0
}

// runRound spawns one child round, supervises it and reports it. It spawns nothing once a stop
// is pending (batch 1 item 1b).
func (c *cycleRunner) runRound(round int) cycleRound {
	c.checkParent()
	if c.stopRequested() {
		return cycleRound{round: round, exit: exitCrawlCancelled}
	}
	c.phase("round", nil)
	dropsBefore := c.pump.droppedCount()
	p, err := c.spawn(round)
	if err != nil {
		log.Printf("[cycle] round %d: cannot start the child (%v) — exit %d", round, err, exitAgentInfra)
		return cycleRound{round: round, exit: exitAgentInfra}
	}
	c.mu.Lock()
	c.inflight = round
	c.mu.Unlock()
	res := c.supervise(p, round)
	c.mu.Lock()
	c.child = nil
	c.mu.Unlock()
	// A child that could not report for itself is reported once, with zero counts. A child the
	// cycle stopped has nothing to report (batch 1 item 1d).
	if !res.done && (res.hung || !c.stopRequested()) {
		c.report("failed", res.exit)
	}
	res.eventsDropped = c.pump.droppedCount() - dropsBefore
	c.emitRoundDone(round, res)
	return res
}

// report sends a zero-count gap report. A dry run sends nothing.
func (c *cycleRunner) report(outcome string, exit int) {
	if c.cfg.dryRun || c.deps.reportGap == nil {
		return
	}
	c.deps.reportGap(c.cfg.cycleID, outcome, exit)
}

// stopRequested reports a pending signal or deadline.
func (c *cycleRunner) stopRequested() bool {
	return c.stop.Reason() != "" || c.budget.Load()
}

// spawn starts one child round in its own process group. Its events come back on a pipe at
// fd 3, and its stdout and stderr go to the cycle's stderr.
func (c *cycleRunner) spawn(round int) (*roundProc, error) {
	argv := c.cfg.childArgv
	if argv == nil {
		argv = defaultChildArgv
	}
	exe, args := argv()

	r, w, err := os.Pipe()
	if err != nil {
		return nil, err
	}
	cmd := exec.Command(exe, args...)
	cmd.Env = c.childEnv()
	cmd.Stdout = os.Stderr
	cmd.Stderr = os.Stderr
	cmd.ExtraFiles = []*os.File{w}
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := cmd.Start(); err != nil {
		_ = r.Close()
		_ = w.Close()
		return nil, err
	}
	_ = w.Close()

	p := &roundProc{
		cmd:      cmd,
		pid:      cmd.Process.Pid,
		pipe:     r,
		lines:    make(chan []byte, 256),
		quit:     make(chan struct{}),
		waitDone: make(chan struct{}),
	}
	go func() {
		defer c.recoverBackground()
		p.readEvents()
	}()
	go func() {
		_ = cmd.Wait()
		close(p.waitDone)
	}()

	c.mu.Lock()
	c.child = p
	// A stop that landed before the child was registered is delivered when the child is ready.
	p.wantTerm = c.stopRequested()
	c.mu.Unlock()

	c.emit("round_start", map[string]any{"round": round, "pid": p.pid, "pgid": p.pid})
	log.Printf("[cycle] round %d: child pid %d (process group %d)", round, p.pid, p.pid)
	return p, nil
}

// childEnv is the cycle's environment, with the cycle's events fd, the cycle id and the run id
// applied. CRAWL_RUN_ID is the cycle id, so the rounds accumulate into one run. CRAWL_DRY_RUN is
// always set explicitly, to the cycle's own dry-run decision.
//
// The control secret is dropped: a cycle never uses it. The workload secret is dropped from the
// inherited environment and handed over only here, because a round mints its own tokens with it.
// The round scrubs it again once it has read it, so Chrome and the driver never inherit it.
func (c *cycleRunner) childEnv() []string {
	drop := map[string]bool{
		crawlEventsFDEnv: true, "CRAWL_CYCLE_ID": true, "CRAWL_RUN_ID": true, "CRAWL_DRY_RUN": true,
		controlSecretEnv: true, workloadTokenSecretEnv: true, tokenSourceEnv: true,
	}
	base := os.Environ()
	env := make([]string, 0, len(base)+6)
	for _, kv := range base {
		k, _, _ := strings.Cut(kv, "=")
		if drop[k] {
			continue
		}
		env = append(env, kv)
	}
	dry := "false"
	if c.cfg.dryRun {
		dry = "true"
	}
	env = append(env,
		crawlEventsFDEnv+"="+cycleChildEventsFDValue,
		"CRAWL_CYCLE_ID="+c.cfg.cycleID,
		"CRAWL_RUN_ID="+c.cfg.cycleID,
		"CRAWL_DRY_RUN="+dry,
		tokenSourceEnv+"="+tokenSourceWorkload,
	)
	if c.cfg.workloadSecret != "" {
		env = append(env, workloadTokenSecretEnv+"="+c.cfg.workloadSecret)
	}
	return env
}

// readEvents reads the child's NDJSON lines. It closes lines at EOF, or when supervision stops
// reading (quit).
func (p *roundProc) readEvents() {
	defer close(p.lines)
	rd := bufio.NewReaderSize(p.pipe, 64*1024)
	for {
		line, err := rd.ReadBytes('\n')
		if len(line) > 0 {
			select {
			case p.lines <- line:
			case <-p.quit:
				return
			}
		}
		if err != nil {
			return
		}
	}
}

// supervise waits for one child and reads its events until it exits. A child silent for
// hungAfter is killed: SIGTERM to its group, then SIGKILL after hungGrace. The events are read on
// this goroutine, but their forwarding never blocks it (see eventPump).
func (c *cycleRunner) supervise(p *roundProc, round int) cycleRound {
	res := cycleRound{round: round}
	defer p.closePipe()
	defer close(p.quit)
	lines := p.lines
	hung := time.NewTimer(c.cfg.hungAfter)
	defer hung.Stop()
	// A child that never reports ready gets its SIGTERM at readyWait, if a stop is pending (N3).
	readyTimer := time.NewTimer(c.cfg.readyWait)
	defer readyTimer.Stop()
	readyArmed := true
	// The parent check runs on a ticker while the child is silent too. It only checks; it never
	// writes an event.
	parentTick := time.NewTicker(parentCheckInterval)
	defer parentTick.Stop()
	for {
		var readyC <-chan time.Time
		if readyArmed {
			readyC = readyTimer.C
		}
		select {
		case <-parentTick.C:
			c.checkParent()
		case <-readyC:
			readyArmed = false
			c.readyDeadline(p)
		case line, ok := <-lines:
			if !ok {
				lines = nil
				continue
			}
			c.absorb(p, round, line, &res)
			c.checkParent()
			if c.pump.isBroken() {
				log.Printf("[cycle] the cycle's events stream closed — stopping new rounds")
				c.requestStop("event-pipe")
			}
			resetTimer(hung, c.cfg.hungAfter)
		case <-p.waitDone:
			c.drainLines(p, round, &res)
			c.finishRound(p, &res)
			return res
		case <-hung.C:
			log.Printf("[cycle] round %d: no event for %s — hung: SIGTERM the process group, SIGKILL after %s", round, c.cfg.hungAfter, c.cfg.hungGrace)
			res.hung = true
			c.killGroup(p)
			c.drainLines(p, round, &res)
			c.finishRound(p, &res)
			return res
		}
	}
}

// resetTimer restarts t for d, draining it first if it fired.
func resetTimer(t *time.Timer, d time.Duration) {
	if !t.Stop() {
		select {
		case <-t.C:
		default:
		}
	}
	t.Reset(d)
}

// drainLines reads the events still buffered after the child exited. It waits at most
// cycleEventDrainWait, because a grandchild that kept the pipe open would otherwise hold it.
func (c *cycleRunner) drainLines(p *roundProc, round int, res *cycleRound) {
	deadline := time.NewTimer(cycleEventDrainWait)
	defer deadline.Stop()
	for {
		select {
		case line, ok := <-p.lines:
			if !ok {
				return
			}
			c.absorb(p, round, line, res)
		case <-deadline.C:
			p.closePipe()
			return
		}
	}
}

// killGroup stops a hung child's whole group: SIGTERM, a grace period, then SIGKILL.
func (c *cycleRunner) killGroup(p *roundProc) {
	_ = syscall.Kill(-p.pid, syscall.SIGTERM)
	if p.groupGone(c.cfg.hungGrace) {
		return
	}
	log.Printf("[cycle] process group %d still running %s after SIGTERM — SIGKILL", p.pid, c.cfg.hungGrace)
	_ = syscall.Kill(-p.pid, syscall.SIGKILL)
	if !p.groupGone(cycleSigKillWait) {
		log.Printf("[cycle] WARNING: process group %d has members after SIGKILL", p.pid)
	}
}

// groupGone reports whether the leader has been reaped and the group is empty, within d.
func (p *roundProc) groupGone(d time.Duration) bool {
	deadline := time.Now().Add(d)
	for {
		select {
		case <-p.waitDone:
			if !groupAlive(p.pid) {
				return true
			}
		default:
		}
		if time.Now().After(deadline) {
			return false
		}
		time.Sleep(cycleGroupPollInterval)
	}
}

// groupAlive reports whether any process still has the group id.
func groupAlive(pgid int) bool {
	return syscall.Kill(-pgid, 0) == nil
}

// finishRound settles the child's exit code. A hang is 11. A child killed by the cycle's second
// signal is 10. A child that died to a signal after the cycle asked it to stop is also 10, not a
// failure (batch 1 item 1d). A signal nobody asked for is internal.
func (c *cycleRunner) finishRound(p *roundProc, res *cycleRound) {
	switch {
	case res.hung:
		res.exit = exitCycleHung
	case c.forced.Load():
		res.exit = exitCrawlCancelled
	default:
		code, signaled := exitStatus(p.cmd)
		switch {
		case signaled && c.stopRequested():
			res.exit = exitCrawlCancelled
		case signaled:
			res.exit = exitCycleInternal
		default:
			res.exit = code
		}
	}
}

// exitStatus is the child's exit code, and whether it died to a signal.
func exitStatus(cmd *exec.Cmd) (int, bool) {
	st := cmd.ProcessState
	if st == nil {
		return exitCycleInternal, true
	}
	if st.Exited() {
		return st.ExitCode(), false
	}
	return exitCycleInternal, true
}

// absorb reads one child event. The child's round_done is read for its counts and not forwarded.
// Ready is consumed: it lets the cycle send the one graceful SIGTERM. Every allowlisted event is
// forwarded with type, cycle_id and round added. Unknown names are dropped.
func (c *cycleRunner) absorb(p *roundProc, round int, line []byte, res *cycleRound) {
	var m map[string]any
	if err := json.Unmarshal(line, &m); err != nil {
		return
	}
	name, _ := m["event"].(string)
	probe, _ := m["probe"].(bool)
	switch name {
	case "ready":
		c.childReady(p)
		return
	case "round_done":
		var d childRoundDone
		if err := json.Unmarshal(line, &d); err != nil {
			return
		}
		res.done = true
		res.processed = d.Processed
		res.succeeded = d.Succeeded
		res.failed = d.Failed
		res.deferred = d.Deferred
		res.blocked = d.BlockedSweeps
		res.needsRewarm = d.NeedsRewarm
		return
	case "claim":
		res.claimed++
	case "ingest_ok":
		if !probe {
			res.pushed++
			if q, _ := m["quarantined"].(bool); q {
				res.quarantined++
			}
		}
		c.noteOK()
	case "ingest_error":
		if !probe {
			res.pushFailed++
		}
	case "page", "fetch", "submit", "finalize_started", "shadow", "shadow_circuit", "startup":
	default:
		return
	}
	m["type"] = name
	m["cycle_id"] = c.cfg.cycleID
	m["round"] = round
	c.pump.offer(func() any { return m })
}

// childReady is the child's "my handler is installed". A stop that was asked for before it was
// ready is delivered now, once.
func (c *cycleRunner) childReady(p *roundProc) {
	c.mu.Lock()
	p.ready = true
	want := p.wantTerm || c.stopRequested()
	c.mu.Unlock()
	if want {
		p.sendTerm()
	}
}

// requestChildTerm asks the running child to stop gracefully. It is sent now when the child is
// ready, and when the child reports ready otherwise. It is sent at most once.
func (c *cycleRunner) requestChildTerm() {
	c.mu.Lock()
	p := c.child
	if p == nil {
		c.mu.Unlock()
		return
	}
	p.wantTerm = true
	ready := p.ready
	c.mu.Unlock()
	if ready {
		p.sendTerm()
	}
}

// requestStop records a stop reason, cancels the cycle's own steps and asks the child to stop.
func (c *cycleRunner) requestStop(reason string) {
	c.stop.request(reason)
	c.cancel()
	c.phase("stopping", nil)
	c.requestChildTerm()
}

// killChildGroup signals the whole group of the running child. It is used only for the hung
// kill's escalation and for the second signal.
func (c *cycleRunner) killChildGroup(sig syscall.Signal) {
	c.mu.Lock()
	p := c.child
	c.mu.Unlock()
	if p != nil {
		_ = syscall.Kill(-p.pid, sig)
	}
}

// watchSignals turns SIGTERM and SIGINT into a stop. The first is a graceful stop. The second
// SIGKILLs the child's group and finishes at once with 10.
func (c *cycleRunner) watchSignals(sigs <-chan os.Signal, done <-chan struct{}) {
	n := 0
	for {
		select {
		case <-done:
			return
		case sig := <-sigs:
			n++
			if n == 1 {
				log.Printf("[cycle] %v: no new rounds; the running round finishes its suburb, then the cycle exits %d", sig, exitCrawlCancelled)
				c.requestStop("signal")
				continue
			}
			log.Printf("[cycle] second %v: SIGKILL the round's process group and exit %d now", sig, exitCrawlCancelled)
			c.forced.Store(true)
			c.stop.request("signal")
			c.cancel()
			c.killChildGroup(syscall.SIGKILL)
			c.forceExit()
			return
		}
	}
}

// forceExit is the second-signal exit: release the lock, finish with the decided code, and exit
// with that same code. If the main path already decided, its code is used, so the summary and the
// process exit agree in every race.
func (c *cycleRunner) forceExit() {
	c.releaseLock()
	code := c.finalize(outCancelled, exitCrawlCancelled)
	c.deps.exit(code)
}

// finalize decides the outcome and exit code once. The first caller writes cycle_done, drains the
// events, prints the one summary line and returns the code. Later callers get the same code back.
func (c *cycleRunner) finalize(outcome string, code int) int {
	c.mu.Lock()
	first := !c.decided
	if first {
		c.decided = true
		c.finalOutcome = outcome
		c.finalCode = code
	}
	o, cd := c.finalOutcome, c.finalCode
	c.mu.Unlock()
	if first {
		// The summary is written first. A later path that blocks on the events flush (a stalled
		// reader), or a second signal during it, can then no longer skip the summary.
		c.printSummary(o, cd)
		c.emit("cycle_done", map[string]any{"outcome": o, "exit_code": cd})
		c.pump.close(cycleEventPumpCloseWait)
	}
	return cd
}

// printSummary writes the one stdout line.
func (c *cycleRunner) printSummary(outcome string, code int) {
	c.mu.Lock()
	counts := c.counts
	pre := struct{ lock, driver, chrome, probe string }{c.preLock, c.preDriver, c.preChrome, c.preProbe}
	var last *string
	if !c.lastOK.IsZero() {
		s := c.lastOK.UTC().Format(time.RFC3339Nano)
		last = &s
	}
	rounds := c.rounds
	c.mu.Unlock()
	counts.EventsDropped = c.pump.droppedCount()

	finished := c.deps.now().UTC()
	started := c.started.UTC()
	if c.started.IsZero() {
		started = finished
	}
	sum := cycleSummary{
		Schema:     cycleSchema,
		CycleID:    c.cfg.cycleID,
		Job:        c.cfg.job,
		DryRun:     c.cfg.dryRun,
		Outcome:    outcome,
		ExitCode:   code,
		Rounds:     rounds,
		StartedAt:  started.Format(time.RFC3339Nano),
		FinishedAt: finished.Format(time.RFC3339Nano),
		Collector:  currentCollector(),
		Lock:       pre.lock,
		Env:        cycleEnvSummary{Driver: pre.driver, Chrome: pre.chrome},
		Ingest:     cycleIngestSummary{Probe: pre.probe, LastOKAt: last},
		Counts:     counts,
	}
	b, err := json.Marshal(sum)
	if err != nil {
		log.Printf("[cycle] summary encode failed: %v", err)
		return
	}
	_, _ = fmt.Fprintf(c.deps.stdout, "%s\n", b)
}

// currentCollector is the build revision `-mode version` reports.
func currentCollector() cycleCollector {
	info, _ := debug.ReadBuildInfo()
	v := resolveCollectorVersion(collectorRevision, info, runtime.Version())
	return cycleCollector{Revision: v.Revision, Modified: v.Modified}
}

// addCounts folds one round's counts into the cycle's totals.
func (c *cycleRunner) addCounts(r cycleRound) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.counts.Claimed += r.claimed
	c.counts.Succeeded += r.succeeded
	c.counts.Failed += r.failed
	c.counts.Deferred += r.deferred
	c.counts.Blocked += r.blocked
	c.counts.Pushed += r.pushed
	c.counts.PushFailed += r.pushFailed
	c.counts.Quarantined += r.quarantined
}

// noteOK records the time of the latest accepted answer from ingest.
func (c *cycleRunner) noteOK() {
	c.mu.Lock()
	c.lastOK = c.deps.now()
	c.mu.Unlock()
}

// setPre updates the preflight state under the lock.
func (c *cycleRunner) setPre(f func()) {
	c.mu.Lock()
	f()
	c.mu.Unlock()
}

// emit queues one cycle event. Every event carries type, ts and cycle_id.
func (c *cycleRunner) emit(typ string, fields map[string]any) {
	m := make(map[string]any, len(fields)+3)
	for k, v := range fields {
		m[k] = v
	}
	m["type"] = typ
	m["cycle_id"] = c.cfg.cycleID
	c.pump.offer(func() any {
		m["ts"] = c.deps.now().UTC().Format(time.RFC3339Nano)
		return m
	})
}

// phase writes a phase event. until is set for a cooldown only.
func (c *cycleRunner) phase(name string, until *time.Time) {
	fields := map[string]any{"name": name}
	if until != nil {
		fields["until"] = until.UTC().Format(time.RFC3339Nano)
	}
	c.emit("phase", fields)
}

// emitPreflight writes the preflight event with the checks' current state.
func (c *cycleRunner) emitPreflight() {
	c.mu.Lock()
	lock, driver, chrome, probe := c.preLock, c.preDriver, c.preChrome, c.preProbe
	c.mu.Unlock()
	c.emit("preflight", map[string]any{
		"lock":   lock,
		"env":    map[string]any{"driver": driver, "chrome": chrome},
		"ingest": map[string]any{"probe": probe},
	})
}

// emitRoundDone writes the cycle's round_done for one child round.
func (c *cycleRunner) emitRoundDone(round int, r cycleRound) {
	c.mu.Lock()
	if c.inflight == round {
		c.inflight = 0
	}
	c.mu.Unlock()
	// Counts are for THIS round only (batch 5 item 4); the summary holds the totals.
	c.emit("round_done", map[string]any{
		"round":     round,
		"exit_code": r.exit,
		"counts": cycleCounts{
			Claimed:       r.claimed,
			Succeeded:     r.succeeded,
			Failed:        r.failed,
			Deferred:      r.deferred,
			Blocked:       r.blocked,
			Pushed:        r.pushed,
			PushFailed:    r.pushFailed,
			Quarantined:   r.quarantined,
			EventsDropped: r.eventsDropped,
		},
	})
}

// --- production wiring ---

// defaultEnsureChrome is the production Chrome warm for a drain or repair. It uses the existing
// warm logic (ensureChromeWarm), in CDP mode only. State is one of not_used, skipped, warm,
// unusable (exit 4) or env_broken (exit 8).
func defaultEnsureChrome(ctx context.Context, probe func(context.Context) int) (string, int) {
	cfg := loadListingsConfig()
	if selectFetcherMode(cfg.crawlConfig) != fetcherModeCDP {
		return "not_used", 0
	}
	ccfg := loadChromeConfig(cfg.cdpURL)
	if !ccfg.autoWarm {
		return "skipped", 0
	}
	deps := chromeDeps{
		reachable: chromeReachable,
		launch:    launchDedicatedChrome,
		recover:   recoverWedgedChrome,
		warmProbe: func() int { return probe(ctx) },
	}
	if err := ensureChromeWarm(ccfg, deps); err != nil {
		if rc := agentExitForWarmFailure(err); rc == exitCrawlEnvBroken {
			return "env_broken", rc
		}
		return "unusable", 4
	}
	return "warm", 0
}

// defaultChromeReachable is the read-only Chrome check the preflight uses. It launches nothing and
// fetches nothing: it asks the CDP endpoint whether /json/version answers. Warmth needs a real REA
// fetch, which a preflight does not make, so the summary says reachable, never warm.
func defaultChromeReachable() string {
	cfg := loadListingsConfig()
	if selectFetcherMode(cfg.crawlConfig) != fetcherModeCDP {
		return "not_used"
	}
	if chromeReachable(loadChromeConfig(cfg.cdpURL).cdpURL) {
		return "reachable"
	}
	return "unreachable"
}

// defaultRecoverChrome is the wedged-Chrome recovery the rc 4 path uses (kill, clear the profile
// locks, relaunch). It applies only to a CDP-driven Chrome.
func defaultRecoverChrome() error {
	cfg := loadListingsConfig()
	if selectFetcherMode(cfg.crawlConfig) != fetcherModeCDP {
		return errors.New("no dedicated Chrome to recover: not CDP mode")
	}
	return recoverWedgedChrome(loadChromeConfig(cfg.cdpURL))
}

// probeWordFor names an ingest probe failure with the contract's ingest.probe word. The same
// words are the ingest_error code.
func probeWordFor(err error) string {
	if err == nil {
		return "ok"
	}
	if strings.HasPrefix(connectMessage(err), "contract_too_old") {
		return "contract"
	}
	return errCodeWord(err)
}

// probeIngestDetail runs ProbeAuth against the pinned ingest URL and returns the S-FETCH exit
// code and the contract word. A contract mismatch is 15. Unimplemented or not found is 8, and its
// probe word is unavailable (the exit code carries the environment fault).
func probeIngestDetail(ctx context.Context, ingestURL string, acfg agentConfig) (int, string) {
	ir := newIngestRound(crawlSinkIngest, acfg, ingestURL, nil)
	resp, err := ir.client.probe(ctx)
	if err == nil && resp.GetMinContractVersion() > housingingest.ContractVersion {
		return exitIngestContract, "contract"
	}
	if err != nil {
		code := ingestRoundExit(err)
		if code == 0 {
			code = exitIngestUnavailable
		}
		return code, probeWordFor(err)
	}
	return 0, "ok"
}

// reportGapWith sends a ReportCycle for a round or a preflight that could not report for itself.
// The counts are zero, because the round's own counts never reached the server.
func reportGapWith(cycleID, outcome string, exit int, ingestURL string, acfg agentConfig) {
	ir := newIngestRound(crawlSinkIngest, acfg, ingestURL, nil)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	req := &pb.ReportCycleRequest{
		CycleId:  cycleID,
		Outcome:  outcome,
		ExitCode: int32(exit),
		Counts:   &pb.CycleCounts{},
	}
	if err := ir.client.reportCycle(ctx, req); err != nil {
		log.Printf("[cycle] ReportCycle for a stalled round failed (best-effort): %s", errCodeWord(err))
	}
}

// --- batch 4 and 5 helpers ---

const (
	// cycleJobUnknown is the job name for a -job value the cycle does not know. The raw value is
	// never written anywhere (batch 5 item 2).
	cycleJobUnknown = "unknown"
	// runtimeWatchdog is the runtime's 30-minute silence watchdog. The child's silence limit, its
	// kill grace and the drain must all land below it (clampHungAfter).
	runtimeWatchdog = 30 * time.Minute
	// hungCeilingMargin is the room kept under the watchdog for process teardown.
	hungCeilingMargin = time.Minute
	// cdpReconnectBudget is the worst case of one CDP reconnect: the driver's start-up plus the
	// attach. playwright-go gives neither a timeout of its own, so this is an estimate, not a bound
	// measured on the rig.
	cdpReconnectBudget = 2 * time.Minute
	// chromeLaunchWorst is launchDedicatedChrome: it waits 12 x 2 s for the CDP port, plus a
	// reachability probe of up to 3 s. A launch costs about 30 s.
	chromeLaunchWorst = 30 * time.Second
	// chromeRecoverWorst is a recovery: killing the dedicated Chrome (about 10 s), then a launch.
	chromeRecoverWorst = chromeLaunchWorst + 10*time.Second
	// defaultStepGrace is how long a step that missed its deadline may still answer with its code.
	defaultStepGrace = 30 * time.Second
	// defaultReadyWait is how long a child may take to report ready before a pending stop's SIGTERM
	// is sent anyway (N3).
	defaultReadyWait = 120 * time.Second
)

// hungClampOnce keeps the clamp's log line to one per process.
var hungClampOnce sync.Once

// validCycleJob reports whether job is one the contract names.
func validCycleJob(job string) bool {
	switch job {
	case cycleJobDrain, cycleJobRepair, cycleJobPreflight:
		return true
	}
	return false
}

// summaryProbeSet is the contract's subset of ingest codes for the summary's ingest.probe.
var summaryProbeSet = map[string]bool{
	"ok": true, "unauthenticated": true, "permission_denied": true, "unavailable": true,
	"contract": true, "token": true, "not_run": true,
}

// summaryProbeWord maps an ingest code onto the summary's subset. A code outside the subset reads as
// unavailable there, while the ingest_error event keeps the full word.
func summaryProbeWord(w string) string {
	if summaryProbeSet[w] {
		return w
	}
	return "unavailable"
}

// contractProbeCode is the ingest_error code: the word itself when the contract names it, else other.
func contractProbeCode(w string) string {
	if ingestCodeWords[w] {
		return w
	}
	return "other"
}

// recoverBackground is deferred by every goroutine the cycle starts. A panic there takes the
// background path (backgroundPanic), not a silent crash. recover is called directly by this deferred
// function, so it sees the panic.
func (c *cycleRunner) recoverBackground() {
	if r := recover(); r != nil {
		log.Printf("[cycle] internal error (background panic): %v\n%s", r, debug.Stack())
		c.backgroundPanic()
	}
}

// backgroundPanic ends the cycle from a goroutine other than the main path: the child group is
// killed, the in-flight round and the summary are written as internal_error with exit 1, and the
// process exits with that code.
func (c *cycleRunner) backgroundPanic() {
	c.killChildGroup(syscall.SIGKILL)
	code := c.finalizePanic()
	c.deps.exit(code)
}

// finalizePanic closes the in-flight round (round_done, exit 1) and finalizes as internal_error.
func (c *cycleRunner) finalizePanic() int {
	c.emitInFlightDone()
	return c.finalize(outInternal, exitCycleInternal)
}

// emitInFlightDone writes round_done for a round that started and never reported one, so every
// round_start has its round_done (contract, batch 5 item 5).
func (c *cycleRunner) emitInFlightDone() {
	c.mu.Lock()
	round := c.inflight
	c.inflight = 0
	c.mu.Unlock()
	if round == 0 {
		return
	}
	c.emit("round_done", map[string]any{"round": round, "exit_code": exitCycleInternal, "counts": cycleCounts{}})
}

// readyDeadline runs when readyWait has passed without the child's ready. A pending stop gets its one
// SIGTERM now, so a child that never reports ready (an older collector) can still be stopped
// gracefully (N3).
func (c *cycleRunner) readyDeadline(p *roundProc) {
	c.mu.Lock()
	want := !p.ready && (p.wantTerm || c.stopRequested())
	c.mu.Unlock()
	if want {
		p.sendTerm()
	}
}

// cycleFetchTimeout is one page fetch's timeout: CRAWL_FETCH_TIMEOUT_S, default 60 s (crawl.go).
func cycleFetchTimeout(getenv func(string) string) time.Duration {
	return time.Duration(cycleEnvInt(getenv, "CRAWL_FETCH_TIMEOUT_S", 60)) * time.Second
}

// cdpWatchdog is the wall-clock ceiling for one page fetch (crawl_cdp.go watchdog()): the value of
// CRAWL_CDP_WATCHDOG_S when it is set, else 3 x the fetch timeout.
func cdpWatchdog(getenv func(string) string) time.Duration {
	if s := cycleEnvInt(getenv, "CRAWL_CDP_WATCHDOG_S", 0); s > 0 {
		return time.Duration(s) * time.Second
	}
	return 3 * cycleFetchTimeout(getenv)
}

// cycleSilenceWorst is the longest the child's events can be silent, in the worst case, from:
//
//	fetch         2 sources x 3 attempts x CRAWL_FETCH_TIMEOUT_S           2 x 3 x 60 s  = 360 s
//	reconnect     cdpReconnectBudget (one reconnect, an estimate)                          = 120 s
//	watchdog      cdpWatchdog: CRAWL_CDP_WATCHDOG_S, else 3 x fetch         3 x 60 s     = 180 s
//	pace          3 x CRAWL_LISTINGS_PAGE_MAX_MS (paceWidenFactorMax)       3 x 20 s     =  60 s
//	push          ingestMaxAttempts x ingestCallTimeout + backoff (1 s, 2 s) 3 x 60 s + 3 s = 183 s
//	suburb pause  CRAWL_MAX_DELAY_MS (between suburbs)                                     =  45 s
//	                                                                        total (defaults) = 948 s
//
// The derived limit is that total, never below hungFloor (20 min), so the default is 20 minutes.
// The total is the sum of worst cases, so no separate margin is added. Each term is a silence the
// child can really have: a page's work, the gap between pages, a push, and the gap between suburbs.
func cycleSilenceWorst(getenv func(string) string) time.Duration {
	fetch := cycleFetchTimeout(getenv)
	pageMax := time.Duration(cycleEnvInt(getenv, "CRAWL_LISTINGS_PAGE_MAX_MS", 20000)) * time.Millisecond
	suburbMax := time.Duration(cycleEnvInt(getenv, "CRAWL_MAX_DELAY_MS", 45000)) * time.Millisecond
	fetchPart := 2 * 3 * fetch
	pace := time.Duration(float64(pageMax) * paceWidenFactorMax)
	push := time.Duration(ingestMaxAttempts)*ingestCallTimeout + ingestBackoff(1) + ingestBackoff(2)
	return fetchPart + cdpReconnectBudget + cdpWatchdog(getenv) + pace + push + suburbMax
}

// warmProbeWorst is one warm probe: a reconnect, the watchdog on its fetch, and the settle.
func warmProbeWorst(getenv func(string) string) time.Duration {
	// runWarmCheck builds a fetcher (a driver start and an attach: one reconnect budget), then fetches
	// with the CDP watchdog. A stalled fetch reconnects once and retries (crawl_cdp.go fetch), which is
	// a second reconnect and a second watchdog. Settle is the page's settle cap.
	return 2*(cdpReconnectBudget+cdpWatchdog(getenv)) + settleCap
}

// chromeStepTimeout is the Chrome step's worst case, following ensureChromeWarm: one launch, then
// (1 + warmMaxAttempts) warm probes, with warmMaxAttempts recoveries, each followed by a launch.
//
//	launch            30 s
//	probes            (1 + 2) x 612 s = 1836 s    (612 s = 2 x (reconnect 120 + watchdog 180) + settle 12)
//	recoveries        2 x (40 s + 30 s) = 140 s
//	total             2006 s, about 33 min
//
// The total is clamped to the runtime ceiling (clampToCeiling), so the step never outlives the 30-minute
// watchdog. Each probe is bounded and reported on its own (warmProbeOnce), so the silence on the events
// fd is one probe at most, never this total.
func chromeStepTimeout(getenv func(string) string) time.Duration {
	return chromeLaunchWorst +
		time.Duration(1+warmMaxAttempts)*warmProbeWorst(getenv) +
		time.Duration(warmMaxAttempts)*(chromeRecoverWorst+chromeLaunchWorst)
}

// hungCeiling is the most the child's silence limit may be: the runtime watchdog, less the kill
// grace (the hung kill's SIGTERM-to-SIGKILL wait), the drain wait, and a margin for teardown.
func hungCeiling(grace time.Duration) time.Duration {
	return runtimeWatchdog - grace - cycleEventDrainWait - hungCeilingMargin
}

// clampHungAfter bounds a silence limit, explicit or derived, so the cycle's kill lands below the
// runtime's watchdog. It logs the clamp once per once value.
func clampHungAfter(d, grace time.Duration, once *sync.Once) time.Duration {
	return clampToCeiling("CRAWL_HUNG_AFTER", d, grace, once)
}

// --- batch 6 helpers ---

// installLockMargin is how much less than the install step's timeout a cycle waits for another install's
// lock, so the wait returns exit 8 before the step's own deadline fires (exit 11).
const installLockMargin = 30 * time.Second

const (
	// minHungGrace and maxHungGrace bound CRAWL_HUNG_GRACE (validateCycleEnv).
	minHungGrace = 10 * time.Second
	maxHungGrace = 5 * time.Minute
)

// chromeClampOnce and warmClampOnce keep each clamp's log line to one per process.
var (
	chromeClampOnce sync.Once
	warmClampOnce   sync.Once
)

// clampToCeiling bounds a step or probe timeout so it lands below the runtime's watchdog, and logs the
// clamp once per once value.
func clampToCeiling(name string, d, grace time.Duration, once *sync.Once) time.Duration {
	ceil := hungCeiling(grace)
	if d <= ceil {
		return d
	}
	once.Do(func() {
		log.Printf("[cycle] %s bound %s is above the ceiling %s (the %s runtime watchdog less the %s grace and the drain); clamped", name, d, ceil, runtimeWatchdog, grace)
	})
	return ceil
}

// warmProbeOnce runs one warm probe under its own bound, between a start and a done startup event.
func (c *cycleRunner) warmProbeOnce(ctx context.Context) int {
	c.warmEvent("start", "")
	return boundedWarm(ctx, c.cfg.warmTimeout, func(pctx context.Context) int {
		return runWarmCheck(pctx, nil)
	}, func(rc int) {
		c.warmEvent("done", warmProbeOutcome(rc))
	})
}

// warmEvent writes a warm_probe startup event. outcome is set only on done (contract).
func (c *cycleRunner) warmEvent(stage, outcome string) {
	fields := map[string]any{"step": "warm_probe", "stage": stage}
	if outcome != "" {
		fields["outcome"] = outcome
	}
	c.emit("startup", fields)
}

// boundedWarm runs one warm probe under bound. A probe still running at the bound is abandoned and reads
// as unusable (4), which the Chrome step turns into a recovery. A panic reads as env_broken (8).
func boundedWarm(ctx context.Context, bound time.Duration, run func(context.Context) int, finish func(rc int)) int {
	res := make(chan int, 1)
	go func() {
		defer func() {
			if r := recover(); r != nil {
				log.Printf("[cycle] warm probe panicked: %v\n%s", r, debug.Stack())
				res <- exitCrawlEnvBroken
			}
		}()
		res <- run(ctx)
	}()
	timer := time.NewTimer(bound)
	defer timer.Stop()
	select {
	case rc := <-res:
		finish(rc)
		return rc
	case <-timer.C:
		log.Printf("[cycle] a warm probe exceeded its %s bound — abandoned, read as unusable", bound)
		finish(4)
		return 4
	case <-ctx.Done():
		finish(4)
		return 4
	}
}
