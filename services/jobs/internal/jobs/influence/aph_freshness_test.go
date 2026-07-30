package influence

import (
	"strings"
	"testing"
)

func TestWriteRegisterFreshnessReportCountsOnlyAlarms(t *testing.T) {
	checks := []freshnessCheck{
		{"aph-waf", "OK", "no 403 responses recorded"},
		{"aph-staleness", "ALARM", "newest fetch 40 day(s) ago"},
		{"aph-extract-backlog", "INFO", "12 unparsed, oldest 3 day(s)"},
		{"coverage-44", "INFO", "0/152 extracted"},
	}
	var sb strings.Builder
	got := writeRegisterFreshnessReport(&sb, checks)
	if got != 1 {
		t.Errorf("alarms = %d, want 1", got)
	}
	out := sb.String()
	for _, want := range []string{"aph-waf", "aph-staleness", "coverage-44", "1 ALARM(S)"} {
		if !strings.Contains(out, want) {
			t.Errorf("report missing %q:\n%s", want, out)
		}
	}
}

func TestWriteRegisterFreshnessReportHealthyExitsZero(t *testing.T) {
	// INFO must never fail the run. An unextracted parliament is an expected
	// state while the vision tier is pending, and alarming on it would train the
	// operator to ignore this check.
	checks := []freshnessCheck{
		{"aph-waf", "OK", ""},
		{"aph-staleness", "OK", ""},
		{"aph-extract-backlog", "INFO", "backlog present but young"},
		{"coverage-45", "INFO", "0/158 extracted"},
		{"coverage-senate", "INFO", "0/35 extracted"},
	}
	var sb strings.Builder
	if got := writeRegisterFreshnessReport(&sb, checks); got != 0 {
		t.Errorf("alarms = %d, want 0 — INFO must not fail the run", got)
	}
	if strings.Contains(sb.String(), "ALARM(S)") {
		t.Error("healthy report should carry no alarm summary line")
	}
}

func TestWafAlarmRefusesUserAgentSpoofing(t *testing.T) {
	// The remediation text is load-bearing: the obvious "fix" for a 403 is to
	// send a browser User-Agent, which is WAF evasion and against the
	// never-bypass-a-block rule. The guidance must say so at the point of
	// failure, not only in a doc nobody opens mid-incident.
	checks := []freshnessCheck{{"aph-waf", "ALARM",
		"1 document(s) returned HTTP 403 — APH may have changed its WAF policy. " +
			"Do NOT work around it by spoofing a browser User-Agent."}}
	var sb strings.Builder
	writeRegisterFreshnessReport(&sb, checks)
	if !strings.Contains(sb.String(), "Do NOT work around it by spoofing") {
		t.Error("WAF alarm must carry the do-not-spoof instruction")
	}
}
