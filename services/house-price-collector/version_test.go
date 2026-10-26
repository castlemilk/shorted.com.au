package main

import (
	"bytes"
	"encoding/json"
	"runtime/debug"
	"strings"
	"testing"
)

func buildInfoWithVCS(rev string, modified string) *debug.BuildInfo {
	info := &debug.BuildInfo{}
	if rev != "" {
		info.Settings = append(info.Settings, debug.BuildSetting{Key: "vcs.revision", Value: rev})
	}
	if modified != "" {
		info.Settings = append(info.Settings, debug.BuildSetting{Key: "vcs.modified", Value: modified})
	}
	return info
}

func TestResolveVersionLDFlagsBeatsBuildInfo(t *testing.T) {
	t.Parallel()
	got := resolveCollectorVersion("abc123", buildInfoWithVCS("def456", "true"), "go1.25.0")
	want := collectorVersion{Revision: "abc123", Modified: false, Source: "ldflags", Go: "go1.25.0"}
	if got != want {
		t.Fatalf("ldflags must win over build info: got %+v, want %+v", got, want)
	}
}

func TestResolveVersionUsesBuildInfoWhenLDFlagsEmpty(t *testing.T) {
	t.Parallel()
	got := resolveCollectorVersion("", buildInfoWithVCS("def456", "true"), "go1.25.0")
	want := collectorVersion{Revision: "def456", Modified: true, Source: "buildinfo", Go: "go1.25.0"}
	if got != want {
		t.Fatalf("build info fallback: got %+v, want %+v", got, want)
	}
}

func TestResolveVersionWhitespaceLDFlagsIsEmpty(t *testing.T) {
	t.Parallel()
	got := resolveCollectorVersion("   ", buildInfoWithVCS("def456", ""), "go1.25.0")
	if got.Source != "buildinfo" || got.Revision != "def456" {
		t.Fatalf("a blank ldflags stamp must not win: got %+v", got)
	}
}

func TestResolveVersionUnknownWhenNeitherPresent(t *testing.T) {
	t.Parallel()
	for name, info := range map[string]*debug.BuildInfo{
		"nil build info":    nil,
		"no vcs settings":   buildInfoWithVCS("", ""),
		"only vcs.modified": buildInfoWithVCS("", "false"),
	} {
		got := resolveCollectorVersion("", info, "go1.25.0")
		want := collectorVersion{Revision: "unknown", Modified: false, Source: "unknown", Go: "go1.25.0"}
		if got != want {
			t.Fatalf("%s: got %+v, want %+v", name, got, want)
		}
	}
}

func TestRunVersionWritesOneJSONLine(t *testing.T) {
	t.Parallel()
	var buf bytes.Buffer
	if rc := runVersion(&buf); rc != 0 {
		t.Fatalf("runVersion rc = %d, want 0", rc)
	}
	out := buf.String()
	if strings.Count(out, "\n") != 1 || !strings.HasSuffix(out, "\n") {
		t.Fatalf("want exactly one newline-terminated line, got %q", out)
	}
	var m map[string]any
	if err := json.Unmarshal([]byte(strings.TrimSpace(out)), &m); err != nil {
		t.Fatalf("not JSON: %v (%q)", err, out)
	}
	for _, k := range []string{"revision", "modified", "source", "go"} {
		if _, ok := m[k]; !ok {
			t.Fatalf("missing key %q in %q", k, out)
		}
	}
	if len(m) != 4 {
		t.Fatalf("want exactly the four documented keys, got %d in %q", len(m), out)
	}
}
