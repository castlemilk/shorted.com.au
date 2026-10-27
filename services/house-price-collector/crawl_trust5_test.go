package main

import (
	"context"
	"os"
	"testing"
)

// Item 1: the host must be one of the two exact allowlisted hosts. Zoned IPv6 literals,
// lookalikes and a non-allowlisted shorted host are all refused.
func TestIngestHostAllowlistIsExact(t *testing.T) {
	prev := testAllowLoopbackIngest
	testAllowLoopbackIngest = false
	t.Cleanup(func() { testAllowLoopbackIngest = prev })

	accept := []string{
		"https://api.shorted.com.au",
		"https://housing-ingest-uiekqxovma-km.a.run.app",
		"https://api.shorted.com.au:443/path",
	}
	reject := []string{
		"https://[::ffff:127.0.0.1%25.shorted.com.au]", // zoned IPv6 literal (proved bypass)
		"https://[fe80::1%25.shorted.com.au]",          // zoned link-local literal
		"https://[::ffff:127.0.0.1]",                   // plain IPv6 literal
		"https://www.shorted.com.au",                   // a shorted host, but not allowlisted
		"https://ingest.shorted.com.au",                // ditto
		"https://shorted.com.au",
		"https://api.shorted.com.au.evil.com",
		"https://housing-ingest-uiekqxovma-km.a.run.app.evil.com",
		"https://127.0.0.1",
	}
	for _, raw := range accept {
		if err := validateIngestURL(raw); err != nil {
			t.Errorf("%s refused: %v", raw, err)
		}
	}
	for _, raw := range reject {
		if err := validateIngestURL(raw); err == nil {
			t.Errorf("%s accepted; the host must be an exact allowlisted name", raw)
		}
	}
}

// Item 5: the resolver returns the validated, normalised URL, and that is what the round
// receives. Whitespace around the value is not carried into the push.
func TestResolveSinkReturnsTheValidatedURL(t *testing.T) {
	env := map[string]string{
		"CRAWL_SINK":         "ingest",
		"SHORTED_INGEST_URL": "  https://api.shorted.com.au  ",
		"CRAWL_DRY_RUN":      "false",
	}
	sink, url, refusal := resolveSink("agent", func(k string) string { return env[k] })
	if refusal != "" || sink != crawlSinkIngest {
		t.Fatalf("sink=%q refusal=%q, want ingest with no refusal", sink, refusal)
	}
	if url != "https://api.shorted.com.au" {
		t.Fatalf("url = %q, want the trimmed, validated value", url)
	}
}

// Item 2: CRAWL_TRACE and CRAWL_TRACE_DIR are refused under ingest and shadow, through the
// real agent entry point, which exits 8.
func TestTraceRefusedUnderIngestAndShadow(t *testing.T) {
	cases := []struct {
		name, key, value string
		refuse           bool
	}{
		{"trace on", "CRAWL_TRACE", "1", true},
		{"trace true", "CRAWL_TRACE", "true", true},
		{"trace zero is still on", "CRAWL_TRACE", "0", true},
		{"trace dir", "CRAWL_TRACE_DIR", "/tmp/trace", true},
		{"trace off", "CRAWL_TRACE", "false", false},
	}
	for _, sink := range []string{"ingest", "shadow"} {
		for _, tc := range cases {
			t.Run(sink+"/"+tc.name, func(t *testing.T) {
				env := map[string]string{
					"CRAWL_SINK":         sink,
					"SHORTED_INGEST_URL": "https://api.shorted.com.au",
					"CRAWL_DRY_RUN":      "false",
					tc.key:               tc.value,
				}
				if sink == "shadow" {
					env["DATABASE_URL"] = "postgres://shadow-only"
					delete(env, "CRAWL_DRY_RUN")
				}
				_, _, refusal := resolveSink("agent", func(k string) string { return env[k] })
				if tc.refuse && refusal == "" {
					t.Fatalf("%s=%s under %s was accepted", tc.key, tc.value, sink)
				}
				if !tc.refuse && refusal != "" {
					t.Fatalf("%s=%s under %s refused: %s", tc.key, tc.value, sink, refusal)
				}
			})
		}
	}
}

// Item 2, the exit code: the agent refuses with 8 before it touches the network.
func TestTraceUnderIngestExits8ThroughRunAgent(t *testing.T) {
	t.Setenv("CRAWL_SINK", "ingest")
	t.Setenv("SHORTED_INGEST_URL", "https://api.shorted.com.au")
	t.Setenv("CRAWL_DRY_RUN", "false")
	t.Setenv("CRAWL_TRACE_DIR", "/tmp/should-not-exist")
	t.Setenv("DATABASE_URL", "")
	if got := runAgent(context.Background(), nil); got != exitSinkRefused {
		t.Fatalf("runAgent with a trace under ingest = %d, want %d", got, exitSinkRefused)
	}
	if _, err := os.Stat("/tmp/should-not-exist"); err == nil {
		t.Fatal("the trace directory was created")
	}
}
