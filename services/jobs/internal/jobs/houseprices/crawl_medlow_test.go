package houseprices

import (
	"bytes"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestEnvInt_WarnsOnUnparseable(t *testing.T) {
	var buf bytes.Buffer
	old := log.Writer()
	log.SetOutput(&buf)
	defer log.SetOutput(old)

	// A SET-but-unparseable value must fall back to the default AND warn (not
	// silently swallow the typo).
	t.Setenv("CRAWL_TEST_INT", "not-a-number")
	if got := envInt("CRAWL_TEST_INT", 7); got != 7 {
		t.Errorf("unparseable env should fall back to default 7, got %d", got)
	}
	if !strings.Contains(buf.String(), "CRAWL_TEST_INT") || !strings.Contains(buf.String(), "not a valid integer") {
		t.Errorf("expected a [config] warning, got %q", buf.String())
	}

	// A valid value parses and does NOT warn.
	buf.Reset()
	t.Setenv("CRAWL_TEST_INT", "42")
	if got := envInt("CRAWL_TEST_INT", 7); got != 42 {
		t.Errorf("valid env should parse to 42, got %d", got)
	}
	if buf.Len() != 0 {
		t.Errorf("a valid env must not warn, got %q", buf.String())
	}

	// Unset falls back silently.
	buf.Reset()
	_ = os.Unsetenv("CRAWL_TEST_INT")
	if got := envInt("CRAWL_TEST_INT", 7); got != 7 || buf.Len() != 0 {
		t.Errorf("unset env should default silently: got %d warn=%q", got, buf.String())
	}
}

func TestEnvFloat_WarnsOnUnparseable(t *testing.T) {
	var buf bytes.Buffer
	old := log.Writer()
	log.SetOutput(&buf)
	defer log.SetOutput(old)

	t.Setenv("CRAWL_TEST_FLOAT", "abc")
	if got := envFloat("CRAWL_TEST_FLOAT", 0.5); got != 0.5 {
		t.Errorf("unparseable float should default to 0.5, got %v", got)
	}
	if !strings.Contains(buf.String(), "not a valid number") {
		t.Errorf("expected a [config] warning, got %q", buf.String())
	}
}

func TestRotateIfOversize(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "telemetry.ndjson")
	if err := os.WriteFile(p, bytes.Repeat([]byte("x"), 100), 0o644); err != nil {
		t.Fatal(err)
	}

	// Under cap: no rotation.
	rotateIfOversize(p, 1000)
	if _, err := os.Stat(p); err != nil {
		t.Errorf("file under cap should NOT rotate: %v", err)
	}
	if _, err := os.Stat(p + ".1"); !os.IsNotExist(err) {
		t.Errorf("no .1 rotation should exist yet")
	}

	// At/over cap: rotate to .1, original moved away.
	rotateIfOversize(p, 50)
	if _, err := os.Stat(p); !os.IsNotExist(err) {
		t.Errorf("over-cap file should have been renamed away")
	}
	if _, err := os.Stat(p + ".1"); err != nil {
		t.Errorf("rotated file .1 should exist: %v", err)
	}

	// Missing file / non-positive cap: no-op, no panic.
	rotateIfOversize(filepath.Join(dir, "does-not-exist"), 10)
	rotateIfOversize(p+".1", 0)
}

func TestIsCDPConnLost(t *testing.T) {
	lost := []string{
		"Target page, context or browser has been closed",
		"connect over CDP to http://localhost:9222: dial tcp: connection refused",
		"websocket: close 1006 (abnormal closure)",
		"Browser has been closed",
		"read: connection closed",
	}
	for _, s := range lost {
		if !isCDPConnLost(fmt.Errorf("%s", s)) {
			t.Errorf("should be treated as a lost CDP connection (recoverable): %q", s)
		}
	}

	kept := []string{
		"Timeout 45000ms exceeded navigating to https://example.com",
		"net::ERR_NAME_NOT_RESOLVED",
		"element not found",
	}
	for _, s := range kept {
		if isCDPConnLost(fmt.Errorf("%s", s)) {
			t.Errorf("ordinary page error should NOT trigger a reconnect: %q", s)
		}
	}
	if isCDPConnLost(nil) {
		t.Error("nil error must not be a lost connection")
	}
}
