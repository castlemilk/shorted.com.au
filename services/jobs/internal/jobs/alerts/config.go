package alerts

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/castlemilk/shorted.com.au/services/jobs/internal/platform"
	"github.com/castlemilk/shorted.com.au/services/jobs/internal/runner"
	"github.com/castlemilk/shorted.com.au/services/pkg/resend"
)

// Canary modes. auto sends the daily proof, and sends one before any customer
// email in a run that has one. always sends every run. off sends none.
const (
	canaryAuto   = "auto"
	canaryAlways = "always"
	canaryOff    = "off"
)

// options are the per-invocation flags.
type options struct {
	dryRun   bool
	canary   string
	maxSends int
	date     Date   // "" unless this is an operator replay
	user     string // with date: limit the replay to one owner
	verbose  bool
}

// settings are the environment variables the job reads.
type settings struct {
	resendAPIKey      string
	resendAPIURL      string
	from              string
	replyTo           string
	canaryTo          string
	rps               float64
	siteURL           string
	unsubscribeSecret string
	shortsAPIURL      string
	internalSecret    string
}

// writeRequired are the variables a live run cannot start without. The dry run
// needs none of them except the database, which ConnectFromEnv checks.
var writeRequired = []string{
	"RESEND_API_KEY",
	"PUBLIC_SITE_URL",
	"UNSUBSCRIBE_SECRET",
}

// readRequired are needed by every run, a dry run included. The entitlement lookup
// decides which candidates are emailed, so a run must never start without the shorts
// API it asks. A missing origin is refused here, never run as "unchecked".
var readRequired = []string{
	"SHORTS_API_URL",
	"INTERNAL_SERVICE_SECRET",
}

// shortsOrigin validates the shorts API origin the entitlement lookup calls. It is
// trimmed first, so a value of only whitespace or "/" is empty and is refused, and it
// must then be an absolute http or https URL with a host. The error names the
// requirement and never the value.
func shortsOrigin(raw string) (string, error) {
	origin := strings.TrimRight(strings.TrimSpace(raw), "/")
	u, err := url.Parse(origin)
	if origin == "" || err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Hostname() == "" {
		return "", errors.New("SHORTS_API_URL must be an absolute http or https URL with a host: the shorts API's Cloud Run origin")
	}
	return origin, nil
}

// parseOptions reads the flags. The dry-run default is the global -dry-run, or
// else ALERTS_DRY_RUN, which is dry when unset or unparseable. An explicit
// -dry-run on the command line wins over both.
func parseOptions(args []string, g runner.Globals, out io.Writer) (options, error) {
	fs := flag.NewFlagSet("shorted alerts", flag.ContinueOnError)
	fs.SetOutput(out)

	dryDefault := g.DryRun || platform.GetEnvBool("ALERTS_DRY_RUN", true)
	dry := fs.Bool("dry-run", dryDefault, "evaluate and log, write nothing and send nothing (default: ALERTS_DRY_RUN, which is true unless set to false)")
	canary := fs.String("canary", canaryAuto, "canary mode: auto (daily proof, and before a run's customer mail), always, or off")
	maxSends := fs.Int("max-sends", 1500, "most emails one run claims")
	date := fs.String("date", "", "replay one daily report date (YYYY-MM-DD) for daily monitors; never moves watermarks")
	user := fs.String("user", "", "with -date: replay only this user's monitors")
	verbose := fs.Bool("verbose", g.Verbose, "log user ids with each candidate")
	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return options{}, runner.ErrUsage
		}
		return options{}, err
	}
	if fs.NArg() > 0 {
		return options{}, fmt.Errorf("unexpected arguments: %s", strings.Join(fs.Args(), " "))
	}

	o := options{dryRun: *dry, canary: *canary, maxSends: *maxSends, user: *user, verbose: *verbose}
	fs.Visit(func(f *flag.Flag) {
		if f.Name == "dry-run" {
			o.dryRun = *dry
		}
	})
	if o.canary != canaryAuto && o.canary != canaryAlways && o.canary != canaryOff {
		return options{}, fmt.Errorf("-canary must be auto, always or off, not %q", o.canary)
	}
	if o.maxSends < 1 {
		return options{}, errors.New("-max-sends must be at least 1")
	}
	if *date != "" {
		if _, err := time.Parse("2006-01-02", *date); err != nil {
			return options{}, fmt.Errorf("-date must be YYYY-MM-DD: %w", err)
		}
		o.date = Date(*date)
	}
	if o.user != "" && o.date == "" {
		return options{}, errors.New("-user needs -date: a replay is for one day and one owner")
	}
	// ALERTS_REPLAY_ONLY is set on the admin replay job (shorted-alerts-replay). That
	// job exists only to replay one owner's day, so a live run without both flags is
	// refused: no argument mix can make it the scheduled sweep. A dry run is unaffected.
	if !o.dryRun && platform.GetEnvBool("ALERTS_REPLAY_ONLY", false) && (o.date == "" || o.user == "") {
		return options{}, errors.New("ALERTS_REPLAY_ONLY is set: a live run needs -date and -user together, one owner's one day")
	}
	return o, nil
}

// loadSettings reads the environment. A missing write-time variable is reported by
// name. Its value is never printed.
func loadSettings(dryRun bool, getenv func(string) string) (settings, error) {
	s := settings{
		resendAPIKey:      getenv("RESEND_API_KEY"),
		resendAPIURL:      firstNonEmpty(getenv("RESEND_API_URL"), resend.DefaultBaseURL),
		from:              firstNonEmpty(getenv("ALERTS_FROM"), "Shorted Alerts <alerts@shorted.com.au>"),
		replyTo:           firstNonEmpty(getenv("ALERTS_REPLY_TO"), "support@shorted.com.au"),
		canaryTo:          firstNonEmpty(getenv("ALERTS_CANARY_TO"), "delivered@resend.dev"),
		rps:               2,
		siteURL:           strings.TrimRight(firstNonEmpty(getenv("PUBLIC_SITE_URL"), "https://shorted.com.au"), "/"),
		unsubscribeSecret: getenv("UNSUBSCRIBE_SECRET"),
		internalSecret:    getenv("INTERNAL_SERVICE_SECRET"),
	}
	if raw := strings.TrimSpace(getenv("ALERTS_RESEND_RPS")); raw != "" {
		v, err := strconv.ParseFloat(raw, 64)
		if err != nil || v <= 0 {
			return settings{}, errors.New("ALERTS_RESEND_RPS must be a positive number")
		}
		s.rps = v
	}
	// Every missing name is reported at once, never a value. A name that is set is
	// then checked for its shape: the origin must be a real one.
	missing := unsetNames(readRequired, getenv)
	what := "missing required environment"
	if !dryRun {
		missing = append(missing, unsetNames(writeRequired, getenv)...)
		what += " for a live run"
	}
	if len(missing) > 0 {
		return settings{}, fmt.Errorf("%s: %s", what, strings.Join(missing, ", "))
	}
	origin, err := shortsOrigin(getenv("SHORTS_API_URL"))
	if err != nil {
		return settings{}, err
	}
	s.shortsAPIURL = origin
	return s, nil
}

// unsetNames lists the variables that are empty. It names them, never their values.
func unsetNames(names []string, getenv func(string) string) []string {
	var missing []string
	for _, name := range names {
		if strings.TrimSpace(getenv(name)) == "" {
			missing = append(missing, name)
		}
	}
	return missing
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}
