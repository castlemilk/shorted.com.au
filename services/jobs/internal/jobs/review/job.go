// Package review is the `shorted review` job — a read-only report of documents
// Shorted could not turn into data: newest results documents never read, empty
// and unreadable extractions, rows the API withholds, and dividend notices that
// failed.
//
// The job reads prod through ONE read-only transaction and never writes.
// Output is markdown to stdout. -text prints one announcement PDF's text as the
// Go parsers read it, to investigate a notice and keep it as a test fixture;
// that touches no database. The playbook is .claude/skills/data-review.
package review

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"time"

	"github.com/castlemilk/shorted.com.au/services/jobs/internal/jobs/reportextract"
	"github.com/castlemilk/shorted.com.au/services/jobs/internal/platform"
	"github.com/castlemilk/shorted.com.au/services/jobs/internal/runner"
	"github.com/jackc/pgx/v5"
)

type config struct {
	days  int
	limit int
	text  string
	pages int
}

// Job returns the `shorted review` subcommand. It never writes.
func Job() runner.Job {
	return runner.Func{
		JobName: "review",
		Desc:    "read-only report of documents Shorted could not turn into data (results, extractions, dividend notices)",
		Fn:      Run,
	}
}

// Run executes the review. It reads from prod through a read-only transaction.
func Run(ctx context.Context, args []string) error {
	fs := flag.NewFlagSet("review", flag.ContinueOnError)
	cfg := config{}
	fs.IntVar(&cfg.days, "days", 90, "window: documents filed, extracted or tried in the last N days")
	fs.IntVar(&cfg.limit, "limit", 25, "rows shown per list; counts are always complete")
	fs.StringVar(&cfg.text, "text", "", "print one announcement PDF's text as the Go parsers read it, then exit (no database)")
	fs.IntVar(&cfg.pages, "pages", 10, "pages read with -text (the dividend notice pass reads 10)")
	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return runner.ErrUsage
		}
		return err
	}
	if fs.NArg() > 0 {
		return fmt.Errorf("unexpected argument %q", fs.Arg(0))
	}
	if cfg.days < 1 {
		return fmt.Errorf("invalid -days %d (want >= 1)", cfg.days)
	}
	if cfg.limit < 1 {
		return fmt.Errorf("invalid -limit %d (want >= 1)", cfg.limit)
	}
	if cfg.text != "" {
		text := reportextract.NewAnnouncementTextFetcher().Text(ctx, cfg.text, cfg.pages)
		if text == "" {
			return fmt.Errorf("review: no text from %s (unresolvable page, not a PDF, unparseable, or too little text)", cfg.text)
		}
		fmt.Println(text)
		return nil
	}

	pool, err := platform.ConnectFromEnv(ctx, platform.WithMaxConns(1))
	if err != nil {
		return fmt.Errorf("review: connect: %w", err)
	}
	defer pool.Close()

	tx, err := pool.BeginTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly})
	if err != nil {
		return fmt.Errorf("review: begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }() // read-only: nothing to keep

	if _, err := tx.Exec(ctx, "SET LOCAL statement_timeout = '120s'"); err != nil {
		return fmt.Errorf("review: set timeout: %w", err)
	}

	src := &pgSource{q: tx}
	rep, err := collect(ctx, src, cfg, time.Now().UTC())
	if err != nil {
		return fmt.Errorf("review: collect: %w", err)
	}

	if _, err := io.WriteString(os.Stdout, render(rep)); err != nil {
		return fmt.Errorf("review: write: %w", err)
	}
	return nil
}
