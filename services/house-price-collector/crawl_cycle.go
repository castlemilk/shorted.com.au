package main

// crawl_cycle.go is `-mode cycle` (S2): the Go twin of the bash drain
// (deploy/housing-crawl-common.sh hc_drain_rounds) and the rig-side entry point that
// BrandBrain's runtime spawns. It runs only with CRAWL_SINK=ingest. A cycle holds no
// database, runs each drain round as a CHILD `-mode agent` in its own process group,
// reads that child's events on CRAWL_EVENTS_FD, and decides what to do next from the
// child's EVENTS and EXIT CODE. It never parses log text.
//
// Jobs:
//
//	drain      lock, preflight (driver, Chrome, ProbeAuth), then child rounds until the
//	           queue is empty, a budget is spent, or a round asks for a stop.
//	repair     lock, forced install-driver, Chrome warm, warmcheck. Exit 0, 4 or 8.
//	preflight  NON-mutating and lock-free. Reports the lock, driver, Chrome and ingest
//	           state, installs nothing and claims nothing. Used for heartbeat and shadow.
//
// Output contract: stdout gets exactly ONE summary JSON line when the cycle ends. Logs go
// to stderr, and a child's stdout and stderr are passed through to the cycle's stderr. The
// cycle's own events go to its CRAWL_EVENTS_FD (when set) as NDJSON: cycle_start,
// preflight, round_start, round_done, cycle_done, plus every child event except the
// child's round_done, each with a "round" number added. The child's round_done is folded
// into the cycle's round_done, so a round has exactly one.
//
// ReportCycle: each child round still reports its own counts-only health row with
// CRAWL_RUN_ID = the cycle id (the server accumulates rounds that share a run id, as the
// bash drain's CRAWL_RUN_ID does). The cycle reports only for a round that could not
// report for itself (a hung round, or one that exited without its round_done). See
// reportGap.

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
)

// exitCycleHung is the cycle's exit code for a round whose child emitted no event for
// CRAWL_HUNG_AFTER. The cycle kills the child's process group and exits 11. No -mode agent
// round returns 11, so it is the cycle's own code.
const exitCycleHung = 11

// exitUsage is the cycle's exit code for a bad -job or -max-duration (the flag package's
// own usage code).
const exitUsage = 2

// The cycle's jobs. -job takes exactly one of these.
const (
	cycleJobDrain     = "drain"
	cycleJobRepair    = "repair"
	cycleJobPreflight = "preflight"
)

// Drain policy defaults. CRAWL_DRAIN_MAX_ROUNDS, CRAWL_REWARM_COOLDOWN_SEC and
// CRAWL_REWARM_MAX_RETRIES keep the names and defaults of the bash drain.
const (
	defaultDrainMaxRounds  = 30
	defaultRewarmCooldown  = 900 * time.Second
	defaultRewarmBudget    = 2
	defaultHungAfter       = 20 * time.Minute
	defaultHungGrace       = 60 * time.Second
	defaultMaxDuration     = 10 * time.Hour
	cycleSigKillWait       = 5 * time.Second
	cycleEventDrainWait    = 5 * time.Second
	cycleGroupPollInterval = 25 * time.Millisecond
	// cycleChildEventsFDValue is the fd the child reads its events on. exec puts the pipe
	// there through ExtraFiles, so it is always fd 3 in the child.
	cycleChildEventsFDValue = "3"
)

// cycleIDPattern admits the IDs the cycle mints and accepts from CRAWL_CYCLE_ID. It is
// bounded the way the events' job IDs are, and never carries free text.
var cycleIDPattern = regexp.MustCompile(`^[A-Za-z0-9._-]{1,64}$`)

// cycleConfig is the policy a cycle runs under. loadCycleConfig fills it from the environment; the
// tests build it directly.
type cycleConfig struct {
	job            string
	dryRun         bool
	maxDuration    time.Duration
	maxRounds      int
	rewarmCooldown time.Duration
	rewarmBudget   int
	hungAfter      time.Duration
	hungGrace      time.Duration
	lockDir        string
	cycleID        string
	// childArgv names the child process. Nil runs this binary as `-mode agent`. The tests
	// point it at the test binary, which runs as a fake child (crawl_cycle_fake_test.go).
	childArgv func() (string, []string)
}

// cycleDeps is every edge the cycle touches that the tests replace with a fake. The
// defaults are the production functions.
type cycleDeps struct {
	driverPresent   func() error                            // playwright driver runs (no install)
	installDriver   func() int                              // runInstallDriver
	ensureChrome    func(ctx context.Context) (string, int) // warm (launches); state, code 0/4/8
	chromeReachable func() string                           // read-only: reachable|unreachable|not_used
	probeIngest     func(ctx context.Context) int           // ProbeAuth; the S-FETCH exit mapping
	warmcheck       func(ctx context.Context) int           // runWarmCheck: 0 warm, 4, 5, 8
	reportGap       func(cycleID, outcome string, exit int) // ReportCycle for a round that could not report
	stdout          io.Writer
	events          *crawlEvents
	now             func() time.Time
	// sigs is the injected signal channel. Nil means SIGTERM and SIGINT via signal.Notify.
	sigs <-chan os.Signal
	// forceExit is the second-signal exit. Nil means: release the lock, finish with
	// outcome cancelled, and os.Exit(10).
	forceExit func()
}

// lockReport is the lock state in the summary and the preflight event.
type lockReport struct {
	State string `json:"state"`
	PID   int    `json:"pid"`
}

// preflightReport is the preflight block of the summary. Each check is "not_run" until it
// runs.
type preflightReport struct {
	Lock   lockReport `json:"lock"`
	Driver string     `json:"driver"`
	Chrome string     `json:"chrome"`
	Ingest string     `json:"ingest"`
}

// cycleCounts are the sums of the rounds' counts. Every field is a count.
type cycleCounts struct {
	Claimed       int `json:"claimed"`
	Processed     int `json:"processed"`
	Succeeded     int `json:"succeeded"`
	Failed        int `json:"failed"`
	Deferred      int `json:"deferred"`
	Listings      int `json:"listings"`
	Events        int `json:"events"`
	BlockedSweeps int `json:"blocked_sweeps"`
	Pushed        int `json:"pushed"`
	PushFailed    int `json:"push_failed"`
	Quarantined   int `json:"quarantined"`
}

// cycleCollector is the build revision, the same pair `-mode version` prints.
type cycleCollector struct {
	Revision string `json:"revision"`
	Modified bool   `json:"modified"`
}

// cycleSummary is the one stdout line.
type cycleSummary struct {
	CycleID    string          `json:"cycle_id"`
	Job        string          `json:"job"`
	Outcome    string          `json:"outcome"`
	ExitCode   int             `json:"exit_code"`
	Rounds     int             `json:"rounds"`
	StartedAt  string          `json:"started_at"`
	FinishedAt string          `json:"finished_at"`
	Collector  cycleCollector  `json:"collector"`
	Counts     cycleCounts     `json:"counts"`
	Preflight  preflightReport `json:"preflight"`
}

// cycleRound is what one child round produced, from its events and its exit.
type cycleRound struct {
	round       int
	exit        int
	done        bool // the child's round_done was seen
	hung        bool
	claimed     int
	pushed      int
	pushFailed  int
	quarantined int
	processed   int
	succeeded   int
	failed      int
	deferred    int
	listings    int
	events      int
	blocked     int
	needsRewarm bool
}

// childRoundDone is the child's round_done, read for its counts and flags.
type childRoundDone struct {
	Processed     int  `json:"processed"`
	Succeeded     int  `json:"succeeded"`
	Failed        int  `json:"failed"`
	Deferred      int  `json:"deferred"`
	Listings      int  `json:"listings"`
	Events        int  `json:"events"`
	BlockedSweeps int  `json:"blocked_sweeps"`
	NeedsRewarm   bool `json:"needs_rewarm"`
}

// childEvent is the part of a child event the cycle reads. Anything else in the line is
// forwarded as it is, under the same allowlist the child's writer already keeps.
type childEvent struct {
	Event       string `json:"event"`
	Quarantined bool   `json:"quarantined"`
}

// roundProc is one running child: its process group, its events and its exit.
type roundProc struct {
	cmd      *exec.Cmd
	pgid     int
	pipe     *os.File
	lines    chan []byte
	quit     chan struct{}
	waitDone chan struct{}
}

// cycleRunner is one cycle. Its counts, preflight and child fields are guarded by mu, and the
// signal goroutine reads them.
type cycleRunner struct {
	cfg    cycleConfig
	deps   cycleDeps
	ctx    context.Context
	cancel context.CancelFunc
	stop   *stopSignal
	// budgetCh is closed when -max-duration fires. budget is set just before.
	budgetCh chan struct{}
	budget   atomic.Bool
	forced   atomic.Bool
	lock     *crawlLock

	mu          sync.Mutex
	child       *roundProc
	lockOwned   bool
	repairSpent bool // install-driver has run once this cycle (preflight or a round's 8)
	rewarms     int
	rounds      int
	counts      cycleCounts
	pre         preflightReport
	started     time.Time
	finishOnce  sync.Once
}

// newCycleRunner builds a runner. Nothing starts until execute.
func newCycleRunner(cfg cycleConfig, deps cycleDeps) *cycleRunner {
	if deps.now == nil {
		deps.now = time.Now
	}
	if deps.stdout == nil {
		deps.stdout = os.Stdout
	}
	ctx, cancel := context.WithCancel(context.Background())
	return &cycleRunner{
		cfg:      cfg,
		deps:     deps,
		ctx:      ctx,
		cancel:   cancel,
		stop:     newStopSignal(),
		budgetCh: make(chan struct{}),
		pre: preflightReport{
			Lock:   lockReport{State: "not_run"},
			Driver: "not_run",
			Chrome: "not_run",
			Ingest: "not_run",
		},
	}
}

// loadCycleConfig reads the cycle's policy from the environment. The -job, -dry-run and
// -max-duration flags are set by the caller.
func loadCycleConfig(getenv func(string) string) cycleConfig {
	cfg := cycleConfig{
		maxRounds:      cycleEnvInt(getenv, "CRAWL_DRAIN_MAX_ROUNDS", defaultDrainMaxRounds),
		rewarmCooldown: time.Duration(cycleEnvInt(getenv, "CRAWL_REWARM_COOLDOWN_SEC", int(defaultRewarmCooldown/time.Second))) * time.Second,
		rewarmBudget:   cycleEnvInt(getenv, "CRAWL_REWARM_MAX_RETRIES", defaultRewarmBudget),
		hungAfter:      cycleEnvDuration(getenv, "CRAWL_HUNG_AFTER", defaultHungAfter),
		hungGrace:      cycleEnvDuration(getenv, "CRAWL_HUNG_GRACE", defaultHungGrace),
		lockDir:        defaultCrawlLockDir(),
	}
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

// runCycleMode is the `-mode cycle` entry point. It refuses every sink but ingest with exit 8,
// and it prints its summary line in every case, refusals included, so the caller always
// has one line to parse.
func runCycleMode(stdout io.Writer, job string, dryRun bool, maxDuration time.Duration, getenv func(string) string, events *crawlEvents) int {
	cfg := loadCycleConfig(getenv)
	cfg.job = job
	cfg.dryRun = dryRun
	cfg.maxDuration = maxDuration

	deps := cycleDeps{
		driverPresent:   checkPlaywrightDriver,
		installDriver:   runInstallDriver,
		ensureChrome:    defaultEnsureChrome,
		chromeReachable: defaultChromeReachable,
		warmcheck:       func(ctx context.Context) int { return runWarmCheck(ctx, nil) },
		stdout:          stdout,
		events:          events,
		now:             time.Now,
	}

	switch job {
	case cycleJobDrain, cycleJobRepair, cycleJobPreflight:
	default:
		log.Printf("[cycle] -job must be drain, repair or preflight (got %q)", job)
		c := newCycleRunner(cfg, deps)
		c.finish("refused", exitUsage)
		return exitUsage
	}
	if maxDuration <= 0 {
		log.Printf("[cycle] -max-duration must be positive (got %s)", maxDuration)
		c := newCycleRunner(cfg, deps)
		c.finish("refused", exitUsage)
		return exitUsage
	}

	// The cycle runs only on the ingest sink. resolveSink does the full validation (the pinned
	// URL, no DATABASE_URL, an explicit CRAWL_DRY_RUN, no gateway, no trace); this adds the
	// refusal of db, shadow and unset.
	sink, ingestURL, refusal := resolveSink("agent", getenv)
	if refusal != "" {
		log.Printf("[cycle] refusing to start: %s", refusal)
		c := newCycleRunner(cfg, deps)
		c.finish("refused", exitSinkRefused)
		return exitSinkRefused
	}
	if sink != crawlSinkIngest {
		log.Printf("[cycle] refusing to start: -mode cycle runs only with %s=ingest (got %q)", crawlSinkEnv, sink)
		c := newCycleRunner(cfg, deps)
		c.finish("refused", exitSinkRefused)
		return exitSinkRefused
	}
	deps.probeIngest = func(ctx context.Context) int {
		return probeIngestWith(ctx, ingestURL)
	}
	deps.reportGap = func(cycleID, outcome string, exit int) {
		reportGapWith(cycleID, outcome, exit, ingestURL)
	}
	deps.events = events
	c := newCycleRunner(cfg, deps)
	return c.execute()
}

// execute runs the job and prints the summary. It is the body the tests call with fakes.
func (c *cycleRunner) execute() int {
	defer c.cancel()
	c.started = c.deps.now()
	c.emit(func(h func(string) eventHeader) any {
		return cycleStartEvent{
			eventHeader:    h("cycle_start"),
			CycleID:        c.cfg.cycleID,
			Job:            c.cfg.job,
			DryRun:         c.cfg.dryRun,
			MaxRounds:      c.cfg.maxRounds,
			MaxDurationSec: int64(c.cfg.maxDuration / time.Second),
		}
	})
	log.Printf("[cycle] %s start: cycle=%s dryRun=%v maxRounds=%d maxDuration=%s hungAfter=%s", c.cfg.job, c.cfg.cycleID, c.cfg.dryRun, c.cfg.maxRounds, c.cfg.maxDuration, c.cfg.hungAfter)

	sigs := c.deps.sigs
	if sigs == nil {
		ch := make(chan os.Signal, 2)
		signal.Notify(ch, syscall.SIGTERM, os.Interrupt)
		defer signal.Stop(ch)
		sigs = ch
	}
	// A child's EPIPE on a dead events pipe must return an error, not kill the cycle.
	signal.Ignore(syscall.SIGPIPE)
	done := make(chan struct{})
	defer close(done)
	go c.watchSignals(sigs, done)

	if c.cfg.maxDuration > 0 {
		t := time.AfterFunc(c.cfg.maxDuration, func() {
			log.Printf("[cycle] -max-duration %s reached: no new rounds; the running round is stopped", c.cfg.maxDuration)
			c.budget.Store(true)
			close(c.budgetCh)
			c.signalChild(syscall.SIGTERM)
		})
		defer t.Stop()
	}

	outcome, code := c.dispatch()
	c.finish(outcome, code)
	return code
}

// dispatch runs the job under the lock (preflight takes none).
func (c *cycleRunner) dispatch() (string, int) {
	switch c.cfg.job {
	case cycleJobPreflight:
		return c.preflightJob()
	case cycleJobRepair:
		return c.withLock(c.repairJob)
	default:
		return c.withLock(c.drainJob)
	}
}

// withLock takes the single-drainer lock (the same lockdir and pid rules as bash) and runs fn
// under it. A held lock is exit 12 and the job does not run. A parent that holds the lock
// passes through (crawl_lock.go's lockPassthrough).
func (c *cycleRunner) withLock(fn func() (string, int)) (string, int) {
	c.lock = newCrawlLock(c.cfg.lockDir)
	outcome, holder, err := c.lock.acquire()
	switch outcome {
	case lockHeld:
		c.setLock(lockReport{State: "held", PID: holder})
		if err != nil {
			log.Printf("[cycle] skipped: %v — claiming nothing (exit %d)", err, exitLockHeld)
		} else {
			log.Printf("[cycle] skipped: lock held by pid %d (%s) — another housing crawl is draining (exit %d)", holder, c.cfg.lockDir, exitLockHeld)
		}
		return "lock_held", exitLockHeld
	case lockError:
		log.Printf("[cycle] FATAL: cannot create the housing-crawl lock at %s (%v) — exit %d", c.cfg.lockDir, err, exitAgentInfra)
		return "failed", exitAgentInfra
	case lockPassthrough:
		c.setLock(lockReport{State: "passthrough", PID: holder})
		log.Printf("[cycle] lock held by parent pid %d — running without taking it", holder)
		return fn()
	default:
		c.mu.Lock()
		c.lockOwned = true
		c.mu.Unlock()
		c.setLock(lockReport{State: "acquired", PID: c.lock.self})
		defer c.releaseLock()
		return fn()
	}
}

// releaseLock releases the lock once. The forced exit path and the normal return both call it.
func (c *cycleRunner) releaseLock() {
	c.mu.Lock()
	owned := c.lockOwned
	c.lockOwned = false
	c.mu.Unlock()
	if owned && c.lock != nil {
		c.lock.release()
	}
}

// inspectLock reads the lock without changing it: free, stale or held, with the holder's
// pid only when the lock records one that is alive.
func inspectLock(dir string) lockReport {
	if _, err := os.Stat(dir); err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return lockReport{State: "free"}
		}
		return lockReport{State: "unknown"}
	}
	pid, ok := readPidFile(filepath.Join(dir, crawlLockPidName))
	if !ok {
		return lockReport{State: "stale"}
	}
	if pidAlive(pid) {
		return lockReport{State: "held", PID: pid}
	}
	return lockReport{State: "stale"}
}

// drainJob is the preflight and then the round loop.
func (c *cycleRunner) drainJob() (string, int) {
	if outcome, code := c.drainPreflight(); code != 0 {
		return outcome, code
	}
	return c.drainRounds()
}

// drainPreflight runs the checks a drain needs before its first round: the driver (installed
// once if missing), Chrome warm (CDP only, with the existing warm logic) and ProbeAuth. The
// first failure ends the cycle.
func (c *cycleRunner) drainPreflight() (string, int) {
	defer c.emitPreflight()
	if code := c.checkDriver(true); code != 0 {
		return "failed", code
	}
	state, code := c.deps.ensureChrome(c.ctx)
	c.setChrome(state)
	if code != 0 {
		return "failed", code
	}
	if code := c.checkIngest(); code != 0 {
		return "failed", code
	}
	return "", 0
}

// checkDriver reports the driver. A missing driver is installed once per cycle when allowed,
// and a second failure, or a failed install, is exit 8.
func (c *cycleRunner) checkDriver(allowInstall bool) int {
	if err := c.deps.driverPresent(); err == nil {
		c.setDriver("ok")
		return 0
	} else {
		log.Printf("[cycle] playwright driver not usable (%v)", err)
	}
	c.mu.Lock()
	spent := c.repairSpent
	if allowInstall && !spent {
		c.repairSpent = true
	}
	c.mu.Unlock()
	if !allowInstall || spent {
		c.setDriver("missing")
		return exitCrawlEnvBroken
	}
	log.Printf("[cycle] installing the playwright driver once (install-driver)")
	if c.deps.installDriver() != 0 {
		c.setDriver("missing")
		return exitCrawlEnvBroken
	}
	if err := c.deps.driverPresent(); err != nil {
		c.setDriver("missing")
		return exitCrawlEnvBroken
	}
	c.setDriver("installed")
	return 0
}

// checkIngest runs ProbeAuth through the S-FETCH mapping (13, 14, 15, 8, 7).
func (c *cycleRunner) checkIngest() int {
	code := c.deps.probeIngest(c.ctx)
	c.setIngest(ingestWord(code))
	return code
}

// ingestWord names an ingest exit for the summary and the preflight event.
func ingestWord(code int) string {
	switch code {
	case 0:
		return "ok"
	case exitIngestAuthRefused:
		return "auth_refused"
	case exitIngestUnavailable:
		return "unavailable"
	case exitIngestContract:
		return "contract"
	case exitCrawlEnvBroken:
		return "env_broken"
	case exitAgentInfra:
		return "token"
	default:
		return "failed"
	}
}

// drainRounds runs child rounds until a stop, a budget or the queue is empty. Its decisions are
// on each round's exit code and events, never on log text.
func (c *cycleRunner) drainRounds() (string, int) {
	for {
		if c.stop.Reason() != "" {
			return "cancelled", exitCrawlCancelled
		}
		if c.budget.Load() {
			return "budget", 0
		}
		c.mu.Lock()
		rounds := c.rounds
		c.mu.Unlock()
		if rounds >= c.cfg.maxRounds {
			log.Printf("[cycle] hit CRAWL_DRAIN_MAX_ROUNDS=%d — stopping (the queue may still hold work)", c.cfg.maxRounds)
			return "max_rounds", 0
		}
		if c.cfg.dryRun && rounds >= 1 {
			// A dry round submits nothing, so the queue never drains. One round is the most a
			// dry run can usefully say.
			return "dry_run", 0
		}
		c.mu.Lock()
		c.rounds++
		round := c.rounds
		c.mu.Unlock()

		res := c.runRound(round)
		c.addCounts(res)
		code := res.exit

		if res.hung {
			return "hung", exitCycleHung
		}
		// A stop beats the child's own normal exits. The child finishes its suburb and exits 10
		// when signalled, and a budget stop is 0 or 10, so both are clean.
		if c.stop.Reason() != "" && (code == 0 || code == exitCrawlCancelled) {
			return "cancelled", exitCrawlCancelled
		}
		if c.budget.Load() && (code == 0 || code == exitCrawlCancelled) {
			return "budget", 0
		}

		switch code {
		case 0:
			if !res.done {
				log.Printf("[cycle] round %d exited 0 without a round_done event: protocol fault", round)
				return "failed", 1
			}
			if res.claimed == 0 && res.processed == 0 {
				return "queue_empty", 0
			}
			continue
		case 3, 5:
			// The bash drain's measured policy, carried over. A re-warm is a routine Kasada
			// outcome, and the cooldown is what lets a retry work. The budget is what stops a
			// blocking portal being hammered: 2 retries measured best (2026-09-11), and more
			// retries against an open circuit only asked the blocking portal again.
			c.mu.Lock()
			spent := c.rewarms >= c.cfg.rewarmBudget
			if !spent {
				c.rewarms++
			}
			retry := c.rewarms
			c.mu.Unlock()
			if spent {
				log.Printf("[cycle] re-warm signalled (rc=%d) and the retry budget is spent after %d retry(ies) — stopping; the next run self-warms", code, c.cfg.rewarmBudget)
				return "rewarm", code
			}
			log.Printf("[cycle] re-warm signalled (rc=%d) — cooling down %s then retrying in this cycle (%d/%d)", code, c.cfg.rewarmCooldown, retry, c.cfg.rewarmBudget)
			c.cooldown(c.cfg.rewarmCooldown)
			continue
		case exitCrawlEnvBroken:
			// install-driver once, then retry the round once, then stop with 8. The repair is
			// shared with the preflight's, so a driver a preflight already repaired is not
			// installed twice.
			c.mu.Lock()
			spent := c.repairSpent
			c.repairSpent = true
			c.mu.Unlock()
			if spent {
				return "env_broken", exitCrawlEnvBroken
			}
			log.Printf("[cycle] round %d exited 8 (environment broken): install-driver once, then retry the round once", round)
			if c.deps.installDriver() != 0 {
				return "env_broken", exitCrawlEnvBroken
			}
			continue
		case exitCrawlCancelled:
			return "cancelled", exitCrawlCancelled
		default:
			// 4, 7, 12, 13, 14, 15 and any other code: stop with that code.
			return "failed", code
		}
	}
}

// cooldown waits d. A signal or the budget ends it early, and the loop's top then decides.
func (c *cycleRunner) cooldown(d time.Duration) {
	if d <= 0 {
		return
	}
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-t.C:
	case <-c.stop.Done():
	case <-c.budgetCh:
	}
}

// repairJob forces the driver install, warms Chrome and runs warmcheck. It is exit 0, 4 or 8.
func (c *cycleRunner) repairJob() (string, int) {
	defer c.emitPreflight()
	if err := c.installForced(); err != nil {
		c.setDriver("missing")
		return "failed", exitCrawlEnvBroken
	}
	c.setDriver("installed")
	state, code := c.deps.ensureChrome(c.ctx)
	c.setChrome(state)
	if code != 0 {
		return "failed", code
	}
	if rc := c.deps.warmcheck(c.ctx); rc != 0 {
		if rc == exitCrawlEnvBroken {
			return "failed", exitCrawlEnvBroken
		}
		return "failed", 4
	}
	return "ok", 0
}

// installForced runs install-driver whether or not the driver is present.
func (c *cycleRunner) installForced() error {
	if c.deps.installDriver() != 0 {
		return errors.New("install-driver failed")
	}
	return nil
}

// preflightJob is the NON-mutating check. It takes no lock, claims nothing and installs
// nothing. It runs every check, and the exit is the first failing check's code. A lock held by
// someone else is reported, not failed: the legacy drainer is expected to hold it while this
// runs in shadow.
func (c *cycleRunner) preflightJob() (string, int) {
	defer c.emitPreflight()
	c.setLock(inspectLock(c.cfg.lockDir))
	first := 0
	if code := c.checkDriver(false); code != 0 {
		first = code
	}
	chrome := c.deps.chromeReachable()
	c.setChrome(chrome)
	if chrome == "unreachable" && first == 0 {
		first = 4
	}
	if code := c.checkIngest(); code != 0 && first == 0 {
		first = code
	}
	if first != 0 {
		return "failed", first
	}
	return "ok", 0
}

// runRound spawns one child round, supervises it and reports the outcome.
func (c *cycleRunner) runRound(round int) cycleRound {
	c.emit(func(h func(string) eventHeader) any {
		return roundStartEvent{eventHeader: h("round_start"), Round: round}
	})
	p, err := c.spawn(round)
	if err != nil {
		log.Printf("[cycle] round %d: cannot start the child (%v) — exit %d", round, err, exitAgentInfra)
		res := cycleRound{round: round, exit: exitAgentInfra}
		c.emitRoundDone(res)
		return res
	}
	res := c.supervise(p, round)
	c.mu.Lock()
	c.child = nil
	c.mu.Unlock()
	if !res.done && c.deps.reportGap != nil {
		// The child could not report for itself (it hung, or it exited without its round_done).
		outcome := "failed"
		if res.exit == exitCrawlCancelled {
			outcome = "cancelled"
		}
		c.deps.reportGap(c.cfg.cycleID, outcome, res.exit)
	}
	c.emitRoundDone(res)
	return res
}

// spawn starts the child in its own process group, with its events on a pipe at fd 3, and its
// stdout and stderr on the cycle's stderr.
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
		pgid:     cmd.Process.Pid,
		pipe:     r,
		lines:    make(chan []byte, 256),
		quit:     make(chan struct{}),
		waitDone: make(chan struct{}),
	}
	go p.readEvents()
	go func() {
		_ = cmd.Wait()
		close(p.waitDone)
	}()

	c.mu.Lock()
	c.child = p
	c.mu.Unlock()
	log.Printf("[cycle] round %d: child pid %d (process group %d)", round, p.pgid, p.pgid)
	// A stop that landed between the start and the store above is forwarded now. The signal
	// side sets the stop before it reads the child, so one of the two always sees the other.
	if c.stop.Reason() != "" || c.budget.Load() {
		c.signalChild(syscall.SIGTERM)
	}
	return p, nil
}

// childEnv is the cycle's own environment, with the cycle's events fd, the cycle id and the run
// id applied. CRAWL_RUN_ID is the cycle id, so every round's health row accumulates into one
// run. A dry run sets CRAWL_DRY_RUN=true.
func (c *cycleRunner) childEnv() []string {
	drop := map[string]bool{crawlEventsFDEnv: true, "CRAWL_CYCLE_ID": true, "CRAWL_RUN_ID": true}
	if c.cfg.dryRun {
		drop["CRAWL_DRY_RUN"] = true
	}
	base := os.Environ()
	env := make([]string, 0, len(base)+4)
	for _, kv := range base {
		k, _, _ := strings.Cut(kv, "=")
		if drop[k] {
			continue
		}
		env = append(env, kv)
	}
	env = append(env,
		crawlEventsFDEnv+"="+cycleChildEventsFDValue,
		"CRAWL_CYCLE_ID="+c.cfg.cycleID,
		"CRAWL_RUN_ID="+c.cfg.cycleID,
	)
	if c.cfg.dryRun {
		env = append(env, "CRAWL_DRY_RUN=true")
	}
	return env
}

// readEvents reads the child's NDJSON lines. It closes lines at EOF, or when the cycle stops
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

// supervise waits for one child and reads its events until it exits. A child that goes silent
// for hungAfter is killed: SIGTERM to its group, then SIGKILL after hungGrace. The result says
// which: a hung child is exit 11, and a child killed by a second signal is exit 10.
func (c *cycleRunner) supervise(p *roundProc, round int) cycleRound {
	defer close(p.quit)
	res := cycleRound{round: round}
	lines := p.lines
	hung := time.NewTimer(c.cfg.hungAfter)
	defer hung.Stop()
	for {
		select {
		case line, ok := <-lines:
			if !ok {
				lines = nil
				continue
			}
			c.absorb(round, line, &res)
			if c.deps.events.broken() && c.stop.Reason() == "" {
				log.Printf("[cycle] events stream closed — stopping new rounds")
				c.stop.request("event-pipe")
				c.signalChild(syscall.SIGTERM)
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
	if p.lines == nil {
		return
	}
	deadline := time.NewTimer(cycleEventDrainWait)
	defer deadline.Stop()
	for {
		select {
		case line, ok := <-p.lines:
			if !ok {
				return
			}
			c.absorb(round, line, res)
		case <-deadline.C:
			_ = p.pipe.Close()
			return
		}
	}
}

// killGroup stops a hung child's whole process group: SIGTERM, a grace period for the group to
// empty, then SIGKILL. A member that survives SIGKILL is logged.
func (c *cycleRunner) killGroup(p *roundProc) {
	_ = syscall.Kill(-p.pgid, syscall.SIGTERM)
	if p.groupGone(c.cfg.hungGrace) {
		return
	}
	log.Printf("[cycle] process group %d still running %s after SIGTERM — SIGKILL", p.pgid, c.cfg.hungGrace)
	_ = syscall.Kill(-p.pgid, syscall.SIGKILL)
	if !p.groupGone(cycleSigKillWait) {
		log.Printf("[cycle] WARNING: process group %d has members after SIGKILL", p.pgid)
	}
}

// groupGone reports whether the leader has been reaped and the group is empty, within d.
func (p *roundProc) groupGone(d time.Duration) bool {
	deadline := time.Now().Add(d)
	for {
		select {
		case <-p.waitDone:
			if !groupAlive(p.pgid) {
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

// finishRound settles the child's exit code. Its own code wins, unless the cycle hung it (11) or
// killed it on a second signal (10). A child that died to a signal the cycle did not send is 1.
func (c *cycleRunner) finishRound(p *roundProc, res *cycleRound) {
	switch {
	case res.hung:
		res.exit = exitCycleHung
	case c.forced.Load():
		res.exit = exitCrawlCancelled
	default:
		res.exit = exitStatus(p.cmd)
	}
}

// exitStatus is the child's exit code, or 1 when it died to a signal.
func exitStatus(cmd *exec.Cmd) int {
	st := cmd.ProcessState
	if st == nil {
		return 1
	}
	if st.Exited() {
		return st.ExitCode()
	}
	return 1
}

// absorb reads one child event. A child's round_done is read for its counts and not forwarded.
// Every other allowlisted event is forwarded with the round number added. Unknown names are
// dropped, so a line the child's writer never produces cannot reach the cycle's stream.
func (c *cycleRunner) absorb(round int, line []byte, res *cycleRound) {
	var ev childEvent
	if err := json.Unmarshal(line, &ev); err != nil || ev.Event == "" {
		return
	}
	switch ev.Event {
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
		res.listings = d.Listings
		res.events = d.Events
		res.blocked = d.BlockedSweeps
		res.needsRewarm = d.NeedsRewarm
		return
	case "claim":
		res.claimed++
	case "ingest_ok":
		res.pushed++
		if ev.Quarantined {
			res.quarantined++
		}
	case "ingest_error":
		res.pushFailed++
	case "page", "fetch", "submit", "finalize_started", "shadow", "shadow_circuit":
	default:
		return
	}
	var m map[string]any
	if err := json.Unmarshal(line, &m); err != nil {
		return
	}
	m["round"] = round
	c.deps.events.emit(func() any { return m })
}

// signalChild sends sig to the running child's process group, if one is running.
func (c *cycleRunner) signalChild(sig syscall.Signal) {
	c.mu.Lock()
	p := c.child
	c.mu.Unlock()
	if p != nil {
		_ = syscall.Kill(-p.pgid, sig)
	}
}

// watchSignals turns SIGTERM and SIGINT into a stop. The first forwards SIGTERM to the running
// child, which finishes its suburb and exits 10. A second SIGKILLs the group and exits 10 at
// once.
func (c *cycleRunner) watchSignals(sigs <-chan os.Signal, done <-chan struct{}) {
	n := 0
	for {
		select {
		case <-done:
			return
		case sig := <-sigs:
			n++
			if n == 1 {
				c.stop.request("signal")
				log.Printf("[cycle] %v: no new rounds; the running round finishes its suburb and the cycle exits %d", sig, exitCrawlCancelled)
				c.signalChild(syscall.SIGTERM)
				continue
			}
			log.Printf("[cycle] second %v: SIGKILL the round's process group and exit %d now", sig, exitCrawlCancelled)
			c.forced.Store(true)
			c.stop.request("signal")
			c.signalChild(syscall.SIGKILL)
			c.cancel()
			c.forceExit()
			return
		}
	}
}

// forceExit is the second-signal exit: release the lock, print the summary and exit. The tests
// replace it.
func (c *cycleRunner) forceExit() {
	if c.deps.forceExit != nil {
		c.deps.forceExit()
		return
	}
	c.releaseLock()
	c.finish("cancelled", exitCrawlCancelled)
	os.Exit(exitCrawlCancelled)
}

// finish prints the summary and emits cycle_done. It runs once.
func (c *cycleRunner) finish(outcome string, code int) {
	c.finishOnce.Do(func() {
		c.emit(func(h func(string) eventHeader) any {
			c.mu.Lock()
			rounds := c.rounds
			c.mu.Unlock()
			return cycleDoneEvent{eventHeader: h("cycle_done"), Outcome: outcome, ExitCode: code, Rounds: rounds}
		})
		c.mu.Lock()
		sum := cycleSummary{
			CycleID:    c.cfg.cycleID,
			Job:        c.cfg.job,
			Outcome:    outcome,
			ExitCode:   code,
			Rounds:     c.rounds,
			StartedAt:  c.started.UTC().Format(time.RFC3339Nano),
			FinishedAt: c.deps.now().UTC().Format(time.RFC3339Nano),
			Collector:  currentCollector(),
			Counts:     c.counts,
			Preflight:  c.pre,
		}
		c.mu.Unlock()
		if sum.StartedAt == "0001-01-01T00:00:00Z" {
			sum.StartedAt = sum.FinishedAt
		}
		b, err := json.Marshal(sum)
		if err != nil {
			log.Printf("[cycle] summary encode failed: %v", err)
			return
		}
		_, _ = fmt.Fprintf(c.deps.stdout, "%s\n", b)
	})
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
	c.counts.Processed += r.processed
	c.counts.Succeeded += r.succeeded
	c.counts.Failed += r.failed
	c.counts.Deferred += r.deferred
	c.counts.Listings += r.listings
	c.counts.Events += r.events
	c.counts.BlockedSweeps += r.blocked
	c.counts.Pushed += r.pushed
	c.counts.PushFailed += r.pushFailed
	c.counts.Quarantined += r.quarantined
}

// setters for the preflight block. They take mu because the signal goroutine's forced exit
// reads it.
func (c *cycleRunner) setLock(l lockReport) {
	c.mu.Lock()
	c.pre.Lock = l
	c.mu.Unlock()
}

func (c *cycleRunner) setDriver(s string) {
	c.mu.Lock()
	c.pre.Driver = s
	c.mu.Unlock()
}

func (c *cycleRunner) setChrome(s string) {
	c.mu.Lock()
	c.pre.Chrome = s
	c.mu.Unlock()
}

func (c *cycleRunner) setIngest(s string) {
	c.mu.Lock()
	c.pre.Ingest = s
	c.mu.Unlock()
}

// Cycle event payloads. Each is an ID, an enum or a count.

type cycleStartEvent struct {
	eventHeader
	CycleID        string `json:"cycle_id"`
	Job            string `json:"job"`
	DryRun         bool   `json:"dry_run"`
	MaxRounds      int    `json:"max_rounds"`
	MaxDurationSec int64  `json:"max_duration_sec"`
}

type cyclePreflightEvent struct {
	eventHeader
	LockState string `json:"lock_state"`
	Driver    string `json:"driver"`
	Chrome    string `json:"chrome"`
	Ingest    string `json:"ingest"`
}

type roundStartEvent struct {
	eventHeader
	Round int `json:"round"`
}

type cycleRoundDoneEvent struct {
	eventHeader
	Round         int  `json:"round"`
	ExitCode      int  `json:"exit_code"`
	Hung          bool `json:"hung"`
	Claimed       int  `json:"claimed"`
	Processed     int  `json:"processed"`
	Succeeded     int  `json:"succeeded"`
	Failed        int  `json:"failed"`
	Deferred      int  `json:"deferred"`
	Listings      int  `json:"listings"`
	Events        int  `json:"events"`
	BlockedSweeps int  `json:"blocked_sweeps"`
	NeedsRewarm   bool `json:"needs_rewarm"`
}

type cycleDoneEvent struct {
	eventHeader
	Outcome  string `json:"outcome"`
	ExitCode int    `json:"exit_code"`
	Rounds   int    `json:"rounds"`
}

// emit writes one cycle event through the cycle's writer. A nil writer is a no-op.
func (c *cycleRunner) emit(build func(h func(string) eventHeader) any) {
	ev := c.deps.events
	ev.emit(func() any { return build(ev.header) })
}

// emitPreflight writes the preflight event with the checks' current state.
func (c *cycleRunner) emitPreflight() {
	c.mu.Lock()
	p := c.pre
	c.mu.Unlock()
	c.emit(func(h func(string) eventHeader) any {
		return cyclePreflightEvent{eventHeader: h("preflight"), LockState: p.Lock.State, Driver: p.Driver, Chrome: p.Chrome, Ingest: p.Ingest}
	})
}

// emitRoundDone writes the cycle's round_done, which carries the child's counts.
func (c *cycleRunner) emitRoundDone(r cycleRound) {
	c.emit(func(h func(string) eventHeader) any {
		return cycleRoundDoneEvent{
			eventHeader: h("round_done"), Round: r.round, ExitCode: r.exit, Hung: r.hung,
			Claimed: r.claimed, Processed: r.processed, Succeeded: r.succeeded, Failed: r.failed,
			Deferred: r.deferred, Listings: r.listings, Events: r.events, BlockedSweeps: r.blocked,
			NeedsRewarm: r.needsRewarm,
		}
	})
}

// defaultEnsureChrome is the production Chrome warm for a drain or repair. It uses the existing
// warm logic (ensureChromeWarm), and only in CDP mode: a Playwright-launched or gateway round has
// no dedicated Chrome to warm. State is one of not_used, skipped, warm, unusable (exit 4) or
// env_broken (exit 8).
func defaultEnsureChrome(ctx context.Context) (string, int) {
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
		warmProbe: func() int { return runWarmCheck(ctx, nil) },
	}
	if err := ensureChromeWarm(ccfg, deps); err != nil {
		if rc := agentExitForWarmFailure(err); rc == exitCrawlEnvBroken {
			return "env_broken", rc
		}
		return "unusable", 4
	}
	return "warm", 0
}

// defaultChromeReachable is the read-only Chrome check the preflight job uses. It launches nothing
// and fetches nothing: it asks the CDP endpoint whether it answers /json/version. Warmth needs a
// real REA fetch, which a preflight does not make, so the summary says "reachable", not "warm".
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

// probeIngestWith runs ProbeAuth against the pinned ingest URL. It uses the S-FETCH client and
// mapping, with no event writer, so the probe emits nothing.
func probeIngestWith(ctx context.Context, ingestURL string) int {
	ir := newIngestRound(crawlSinkIngest, loadAgentConfig(), ingestURL, nil)
	return ir.probe(ctx)
}

// reportGapWith sends a ReportCycle for a round that could not report for itself. The counts are
// zero, because the round's own counts never reached the server.
func reportGapWith(cycleID, outcome string, exit int, ingestURL string) {
	ir := newIngestRound(crawlSinkIngest, loadAgentConfig(), ingestURL, nil)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	req := &pb.ReportCycleRequest{
		CycleId:  cycleID,
		Outcome:  outcome,
		ExitCode: int32(exit),
		Counts:   &pb.CycleCounts{},
	}
	if err := ir.client.reportCycle(ctx, req); err != nil {
		log.Printf("[cycle] ReportCycle for a round that could not report failed (best-effort): %s", errCodeWord(err))
	}
}
