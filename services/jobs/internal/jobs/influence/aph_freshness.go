package influence

// Freshness sentinel for the APH register crawl.
//
// Runs as `-mode register-freshness` from a scheduled GitHub Action, exactly like
// economy-collector's `-mode freshness`: any ALARM exits non-zero, the workflow
// fails, GitHub notifies. There is no dashboard to remember to look at.
//
// Three alarms, each for a failure that is otherwise SILENT:
//
//  1. WAF BLOCK. aph.gov.au allowlists real-browser User-Agent tokens and 403s
//     everything else, so our posture (omit the UA, self-identify via From: and
//     X-Crawler-Contact:) is a policy the site can revoke at any time. If it
//     does, every fetch 403s, the queue drains to 'blocked', and nothing else
//     looks wrong — the last successful corpus just stops growing. This is the
//     most likely quiet death of the crawl and gets its own alarm.
//
//  2. STALENESS. The registers change continuously during sitting periods. A
//     corpus whose newest fetched document is older than the threshold means the
//     crawl has stopped running, regardless of why.
//
//  3. EXTRACTION BACKLOG. Documents fetched but never parsed are invisible in
//     the UI — a member simply shows fewer entries. A backlog that has sat
//     unparsed past the threshold means the extractor is not draining.
//
// A backlog of SCANNED documents is NOT an alarm: those wait on the vision tier
// by design, and alarming on them would train the operator to ignore this check.

import (
	"context"
	"fmt"
	"io"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	// Days before the newest fetched document counts as stale. The House
	// listings carry a per-member last-updated date and change through sitting
	// weeks; a month of silence is a stopped crawl, not a quiet parliament.
	defaultRegisterStaleDays = 28

	// Days a fetched-but-unparsed text document may sit before the extractor is
	// considered stuck. Generous: a run that fetches a new parliament legitimately
	// leaves a backlog until the next extract pass.
	defaultRegisterBacklogDays = 14
)

type freshnessCheck struct {
	Name   string
	Status string // "OK" | "ALARM" | "INFO"
	Detail string
}

// collectRegisterFreshness runs the three checks. It returns checks even on a
// partial failure so the report shows what it did manage to read.
func collectRegisterFreshness(ctx context.Context, pool *pgxpool.Pool, now time.Time) ([]freshnessCheck, error) {
	var checks []freshnessCheck

	// --- 1. WAF block -------------------------------------------------------
	var blocked int
	var lastBlockedURL *string
	if err := pool.QueryRow(ctx, `
		SELECT count(*),
		       (SELECT source_url FROM register_documents
		         WHERE http_status = 403 ORDER BY updated_at DESC LIMIT 1)
		FROM register_documents
		WHERE http_status = 403`).Scan(&blocked, &lastBlockedURL); err != nil {
		return checks, fmt.Errorf("waf check: %w", err)
	}
	switch {
	case blocked == 0:
		checks = append(checks, freshnessCheck{"aph-waf", "OK", "no 403 responses recorded"})
	default:
		url := ""
		if lastBlockedURL != nil {
			url = *lastBlockedURL
		}
		checks = append(checks, freshnessCheck{"aph-waf", "ALARM", fmt.Sprintf(
			"%d document(s) returned HTTP 403 — APH may have changed its WAF policy. "+
				"Do NOT work around it by spoofing a browser User-Agent. Re-probe the "+
				"no-UA posture by hand and, if it is genuinely revoked, stop crawling "+
				"and contact the publisher. Most recent: %s", blocked, url)})
	}

	// --- 2. Staleness -------------------------------------------------------
	var newestFetch *time.Time
	var fetched int
	if err := pool.QueryRow(ctx, `
		SELECT max(fetched_at), count(*) FILTER (WHERE fetch_status = 'fetched')
		FROM register_documents`).Scan(&newestFetch, &fetched); err != nil {
		return checks, fmt.Errorf("staleness check: %w", err)
	}
	switch {
	case fetched == 0:
		// Never crawled is a configuration state, not a regression. Report it
		// loudly but do not fail a fresh environment's first check.
		checks = append(checks, freshnessCheck{"aph-staleness", "INFO",
			"no documents fetched yet — the register crawl has never run in this environment"})
	case newestFetch == nil:
		checks = append(checks, freshnessCheck{"aph-staleness", "ALARM",
			fmt.Sprintf("%d documents marked fetched but none carries fetched_at", fetched)})
	default:
		age := int(now.Sub(*newestFetch).Hours() / 24)
		detail := fmt.Sprintf("newest fetch %d day(s) ago (%s), %d documents",
			age, newestFetch.Format("2006-01-02"), fetched)
		if age > defaultRegisterStaleDays {
			checks = append(checks, freshnessCheck{"aph-staleness", "ALARM",
				fmt.Sprintf("%s — threshold %d days", detail, defaultRegisterStaleDays)})
		} else {
			checks = append(checks, freshnessCheck{"aph-staleness", "OK", detail})
		}
	}

	// --- 3. Extraction backlog ---------------------------------------------
	//
	// Scans are excluded: they wait on the vision tier by design. Counting them
	// would keep this alarm permanently red and train the operator to ignore it.
	var backlog int
	var oldestPending *time.Time
	if err := pool.QueryRow(ctx, `
		SELECT count(*), min(fetched_at)
		FROM register_documents
		WHERE fetch_status = 'fetched'
		  AND (extract_status IS NULL OR extract_status NOT IN ('extracted', 'partial'))
		  AND COALESCE(text_class, '') <> 'scan'`).Scan(&backlog, &oldestPending); err != nil {
		return checks, fmt.Errorf("backlog check: %w", err)
	}
	switch {
	case backlog == 0:
		checks = append(checks, freshnessCheck{"aph-extract-backlog", "OK", "no unparsed text documents"})
	case oldestPending == nil:
		checks = append(checks, freshnessCheck{"aph-extract-backlog", "OK",
			fmt.Sprintf("%d unparsed, none with a fetch timestamp", backlog)})
	default:
		age := int(now.Sub(*oldestPending).Hours() / 24)
		detail := fmt.Sprintf("%d text document(s) fetched but unparsed, oldest %d day(s)", backlog, age)
		if age > defaultRegisterBacklogDays {
			checks = append(checks, freshnessCheck{"aph-extract-backlog", "ALARM",
				fmt.Sprintf("%s — threshold %d days; the extractor is not draining", detail, defaultRegisterBacklogDays)})
		} else {
			checks = append(checks, freshnessCheck{"aph-extract-backlog", "INFO", detail})
		}
	}

	// --- Context (never an alarm) ------------------------------------------
	// Coverage is reported so the operator reading a failure sees the shape of
	// the corpus without another query. Unextracted parliaments are an expected
	// state while the vision tier is pending, NOT a fault.
	rows, err := pool.Query(ctx, `
		SELECT COALESCE(parliament::text, 'senate'),
		       count(*),
		       count(*) FILTER (WHERE extract_status = 'extracted')
		FROM register_documents
		GROUP BY 1 ORDER BY 1 DESC`)
	if err != nil {
		return checks, fmt.Errorf("coverage: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var parliament string
		var docs, extracted int
		if err := rows.Scan(&parliament, &docs, &extracted); err != nil {
			return checks, fmt.Errorf("coverage scan: %w", err)
		}
		checks = append(checks, freshnessCheck{
			Name:   "coverage-" + parliament,
			Status: "INFO",
			Detail: fmt.Sprintf("%d/%d extracted", extracted, docs),
		})
	}
	return checks, rows.Err()
}

// writeRegisterFreshnessReport prints the report and returns the alarm count.
func writeRegisterFreshnessReport(w io.Writer, checks []freshnessCheck) int {
	alarms := 0
	fmt.Fprintf(w, "%-24s %-6s %s\n", "CHECK", "STATUS", "DETAIL")
	for _, c := range checks {
		if c.Status == "ALARM" {
			alarms++
		}
		fmt.Fprintf(w, "%-24s %-6s %s\n", c.Name, c.Status, c.Detail)
	}
	if alarms > 0 {
		fmt.Fprintf(w, "\n%d ALARM(S) — see docs/feature/politicians/architecture.md\n", alarms)
	}
	return alarms
}
