package alerts

import (
	"bytes"
	"errors"
	"strings"
	"testing"

	"github.com/castlemilk/shorted.com.au/services/jobs/internal/runner"
)

func TestDryRunDefaultsToDryWhenUnset(t *testing.T) {
	t.Setenv("ALERTS_DRY_RUN", "")
	o, err := parseOptions(nil, runner.Globals{}, &bytes.Buffer{})
	if err != nil {
		t.Fatal(err)
	}
	if !o.dryRun {
		t.Fatal("an unset ALERTS_DRY_RUN must be a dry run")
	}
}

func TestDryRunFalseEnvWrites(t *testing.T) {
	t.Setenv("ALERTS_DRY_RUN", "false")
	o, err := parseOptions(nil, runner.Globals{}, &bytes.Buffer{})
	if err != nil {
		t.Fatal(err)
	}
	if o.dryRun {
		t.Fatal(`ALERTS_DRY_RUN=false must write`)
	}
}

func TestUnparseableDryRunEnvStaysDry(t *testing.T) {
	t.Setenv("ALERTS_DRY_RUN", "nope")
	o, _ := parseOptions(nil, runner.Globals{}, &bytes.Buffer{})
	if !o.dryRun {
		t.Fatal("an unparseable value must fail safe to a dry run")
	}
}

func TestGlobalDryRunWinsOverEnv(t *testing.T) {
	t.Setenv("ALERTS_DRY_RUN", "false")
	o, err := parseOptions(nil, runner.Globals{DryRun: true}, &bytes.Buffer{})
	if err != nil {
		t.Fatal(err)
	}
	if !o.dryRun {
		t.Fatal("a global -dry-run must force a dry run over ALERTS_DRY_RUN=false")
	}
}

func TestExplicitDryRunFalseOverridesGlobal(t *testing.T) {
	t.Setenv("ALERTS_DRY_RUN", "")
	o, err := parseOptions([]string{"-dry-run=false"}, runner.Globals{DryRun: true}, &bytes.Buffer{})
	if err != nil {
		t.Fatal(err)
	}
	if o.dryRun {
		t.Fatal("an explicit -dry-run=false must write")
	}
}

func TestUserNeedsDate(t *testing.T) {
	if _, err := parseOptions([]string{"-user", "u1"}, runner.Globals{}, &bytes.Buffer{}); err == nil {
		t.Fatal("-user without -date must be refused")
	}
	o, err := parseOptions([]string{"-date", "2026-10-16", "-user", "u1"}, runner.Globals{}, &bytes.Buffer{})
	if err != nil || o.date != "2026-10-16" || o.user != "u1" {
		t.Fatalf("replay flags: %+v %v", o, err)
	}
}

func TestDateMustBeISO(t *testing.T) {
	if _, err := parseOptions([]string{"-date", "16/10/2026"}, runner.Globals{}, &bytes.Buffer{}); err == nil {
		t.Fatal("a non-ISO date must be refused")
	}
}

func TestCanaryModeIsValidated(t *testing.T) {
	for _, mode := range []string{"auto", "always", "off"} {
		if _, err := parseOptions([]string{"-canary", mode}, runner.Globals{}, &bytes.Buffer{}); err != nil {
			t.Fatalf("-canary %s: %v", mode, err)
		}
	}
	if _, err := parseOptions([]string{"-canary", "sometimes"}, runner.Globals{}, &bytes.Buffer{}); err == nil {
		t.Fatal("an unknown canary mode must be refused")
	}
}

func TestMaxSendsMustBePositive(t *testing.T) {
	if _, err := parseOptions([]string{"-max-sends", "0"}, runner.Globals{}, &bytes.Buffer{}); err == nil {
		t.Fatal("-max-sends 0 must be refused")
	}
}

func TestHelpIsUsage(t *testing.T) {
	var out bytes.Buffer
	_, err := parseOptions([]string{"-h"}, runner.Globals{}, &out)
	if !errors.Is(err, runner.ErrUsage) {
		t.Fatalf("-h must be runner.ErrUsage, got %v", err)
	}
}

func env(values map[string]string) func(string) string {
	return func(name string) string { return values[name] }
}

func TestDryRunNeedsNoWriteSettings(t *testing.T) {
	// A dry run still asks the shorts API, so it needs the origin and the secret, but
	// none of the write settings.
	if _, err := loadSettings(true, env(map[string]string{
		"SHORTS_API_URL":          "https://shorts-api.example.run",
		"INTERNAL_SERVICE_SECRET": "internal",
	})); err != nil {
		t.Fatalf("a dry run needs no write settings: %v", err)
	}
	_, err := loadSettings(true, env(nil))
	if err == nil || !strings.Contains(err.Error(), "SHORTS_API_URL") || strings.Contains(err.Error(), "RESEND_API_KEY") {
		t.Fatalf("a dry run must name only the read settings it lacks, got %v", err)
	}
}

// SHORTS_API_URL is validated after trimming. A value that trims to nothing, such as "/",
// must fail at startup, so the entitlement lookup can never run against no origin.
func TestShortsAPIURLMustBeAnAbsoluteOrigin(t *testing.T) {
	for _, raw := range []string{"", "   ", "/", " / ", "shorts-api.example.run", "/api", "ftp://shorts-api.example.run", "https://", "http://:8080"} {
		_, err := loadSettings(true, env(map[string]string{
			"SHORTS_API_URL":          raw,
			"INTERNAL_SERVICE_SECRET": "internal",
		}))
		if err == nil || !strings.Contains(err.Error(), "SHORTS_API_URL") {
			t.Fatalf("SHORTS_API_URL %q must fail at startup, got %v", raw, err)
		}
	}
	for raw, want := range map[string]string{
		"https://shorts-api.example.run":     "https://shorts-api.example.run",
		"  https://shorts-api.example.run/ ": "https://shorts-api.example.run",
		"http://127.0.0.1:9091":              "http://127.0.0.1:9091",
	} {
		s, err := loadSettings(true, env(map[string]string{
			"SHORTS_API_URL":          raw,
			"INTERNAL_SERVICE_SECRET": "internal",
		}))
		if err != nil {
			t.Fatalf("SHORTS_API_URL %q: %v", raw, err)
		}
		if s.shortsAPIURL != want {
			t.Fatalf("SHORTS_API_URL %q normalised to %q, want %q", raw, s.shortsAPIURL, want)
		}
	}
}

func TestLiveRunListsMissingNamesNeverValues(t *testing.T) {
	const secret = "s3cret-value-do-not-print"
	_, err := loadSettings(false, env(map[string]string{
		"UNSUBSCRIBE_SECRET": secret,
		"PUBLIC_SITE_URL":    "https://shorted.com.au",
	}))
	if err == nil {
		t.Fatal("a live run with missing settings must fail")
	}
	msg := err.Error()
	for _, name := range []string{"RESEND_API_KEY", "SHORTS_API_URL", "INTERNAL_SERVICE_SECRET"} {
		if !strings.Contains(msg, name) {
			t.Fatalf("error must name %s: %q", name, msg)
		}
	}
	if strings.Contains(msg, secret) || strings.Contains(msg, "UNSUBSCRIBE_SECRET") {
		t.Fatalf("error must not print a value or a set variable: %q", msg)
	}
}

func TestLiveRunDefaultsAndOverrides(t *testing.T) {
	s, err := loadSettings(false, env(map[string]string{
		"RESEND_API_KEY":          "k",
		"PUBLIC_SITE_URL":         "https://shorted.com.au/",
		"UNSUBSCRIBE_SECRET":      "u",
		"SHORTS_API_URL":          "https://shorts.example/",
		"INTERNAL_SERVICE_SECRET": "i",
		"ALERTS_RESEND_RPS":       "5",
	}))
	if err != nil {
		t.Fatal(err)
	}
	if s.from != "Shorted Alerts <alerts@shorted.com.au>" || s.replyTo != "support@shorted.com.au" {
		t.Fatalf("sender defaults: %q %q", s.from, s.replyTo)
	}
	if s.canaryTo != "delivered@resend.dev" || s.rps != 5 {
		t.Fatalf("canary/rps: %q %v", s.canaryTo, s.rps)
	}
	if s.siteURL != "https://shorted.com.au" || s.shortsAPIURL != "https://shorts.example" {
		t.Fatalf("trailing slashes must be trimmed: %q %q", s.siteURL, s.shortsAPIURL)
	}
}

func TestInvalidRateIsRefused(t *testing.T) {
	_, err := loadSettings(true, env(map[string]string{"ALERTS_RESEND_RPS": "fast"}))
	if err == nil {
		t.Fatal("a non-numeric rate must be refused")
	}
}
