// Package ownership is the `shorted ownership` job: who holds ASX stocks.
//
// It maps the investors (super funds, index managers, hedge funds, active
// managers, banks and brokers, sovereign funds) and reads what they hold from
// three public sources:
//
//	-mode registry  sync the curated institutions (registry.go) and re-link
//	                stored notices to them
//	-mode funds     APRA's fund-level statistics (every super fund, total
//	                assets) and ASX's Investment Products report (every ETF,
//	                LIC and LIT, issuer and size) into ownership_funds
//	-mode etf       daily holdings of the large Australian-equity index ETFs
//	                (iShares, Vanguard, SPDR, Betashares)
//	-mode phd       super funds' portfolio holdings disclosures (default or
//	                balanced option, semi-annual)
//	-mode notices   ASX substantial holding notices (Forms 603/604/605),
//	                selected from asx_announcements and read from their PDFs
//	-mode all       registry, funds, etf, phd, notices, in that order
//
// -dry-run (default true in code: REGISTER_DRY_RUN's convention, so a hand
// run never writes by accident) reads every source and writes nothing.
//
// Exit codes: 1 when a mode collected nothing (every source failed, or the
// database is unreachable); 10 (DEGRADED) when some sources failed and the
// rest were stored.
//
// After a run that stored anything it waits -revalidate-wait for the API's
// ownership cache (10 minutes) to turn over, then pings the web tier's
// /api/revalidate (tag and KV family "ownership"). Best-effort: a failed or
// skipped ping never fails the run, and the pages self-heal on their TTLs.
package ownership

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"sort"
	"strings"
	"time"

	"github.com/castlemilk/shorted.com.au/services/jobs/internal/jobs/reportextract"
	"github.com/castlemilk/shorted.com.au/services/jobs/internal/pdfchild"
	"github.com/castlemilk/shorted.com.au/services/jobs/internal/platform"
	"github.com/castlemilk/shorted.com.au/services/jobs/internal/runner"
)

const (
	modeRegistry = "registry"
	modeFunds    = "funds"
	modeNotices  = "notices"
	modeETF      = "etf"
	modePHD      = "phd"
	modeAll      = "all"
)

const exitCodeDegraded = 10

// revalidateWait outlasts the API's ownership cache (ownershipTTL in
// services/shorts/internal/services/shorts/ownership.go, 10 minutes), so the
// re-render the ping starts reads this run's rows, not the cached response.
const revalidateWait = 11 * time.Minute

type config struct {
	mode    string
	dryRun  bool
	limit   int
	since   string
	workers int
	delay   time.Duration
	childMB int
	rvWait  time.Duration
}

// Job returns the `shorted ownership` subcommand.
func Job() runner.Job {
	return runner.Func{
		JobName: "ownership",
		Desc:    "map super funds, index funds and hedge funds to the ASX stocks they hold (substantial holder notices, ETF and super fund holdings)",
		DryRun:  true,
		Fn:      Run,
	}
}

// Run executes one mode.
func Run(ctx context.Context, args []string) error {
	globals := runner.FromContext(ctx)
	fs := flag.NewFlagSet("ownership", flag.ContinueOnError)
	cfg := config{}
	fs.StringVar(&cfg.mode, "mode", modeAll, "registry | funds | etf | phd | notices | all")
	fs.BoolVar(&cfg.dryRun, "dry-run", defaultDryRun(globals.DryRun), "read every source, write nothing (default true unless OWNERSHIP_DRY_RUN=false)")
	fs.IntVar(&cfg.limit, "limit", 400, "notices: the most notice PDFs to read this run, newest first")
	fs.StringVar(&cfg.since, "since", "2024-01-01", "notices: read notices released on or after this date")
	fs.IntVar(&cfg.workers, "workers", 3, "notices: concurrent PDF downloads")
	fs.DurationVar(&cfg.delay, "delay", 400*time.Millisecond, "notices: pause per worker between ASX downloads")
	fs.IntVar(&cfg.childMB, "child-memory-mb", 2048, "notices: resident memory shared by the PDF reader children (a large encrypted notice needs about 32x its size)")
	fs.DurationVar(&cfg.rvWait, "revalidate-wait", revalidateWait, "wait before revalidating the web pages after a run that stored rows (0 pings at once)")
	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return runner.ErrUsage
		}
		return err
	}
	if fs.NArg() > 0 {
		return fmt.Errorf("unexpected argument %q (modes are passed as -mode %s)", fs.Arg(0), fs.Arg(0))
	}
	if _, err := time.Parse("2006-01-02", cfg.since); err != nil {
		return fmt.Errorf("-since %q is not YYYY-MM-DD", cfg.since)
	}

	db, err := platform.ConnectFromEnv(ctx, platform.WithMaxConns(int32(max(cfg.workers, 1)+2)))
	if err != nil {
		return err
	}
	defer db.Close()
	st := &pgStore{db: db}
	client := &http.Client{Timeout: 2 * time.Minute}
	log.Printf("ownership: mode=%s dryRun=%v", cfg.mode, cfg.dryRun)

	var modes []string
	switch cfg.mode {
	case modeAll:
		modes = []string{modeRegistry, modeFunds, modeETF, modePHD, modeNotices}
	case modeRegistry, modeFunds, modeETF, modePHD, modeNotices:
		modes = []string{cfg.mode}
	default:
		return fmt.Errorf("unknown -mode %q", cfg.mode)
	}

	var failed []string
	total := 0
	for _, m := range modes {
		if err := ctx.Err(); err != nil {
			return err
		}
		var f []string
		var n int
		switch m {
		case modeRegistry:
			f, n = runRegistry(ctx, st, cfg)
		case modeFunds:
			f, n = runFunds(ctx, st, client, cfg)
		case modeETF:
			f, n = runETF(ctx, st, client, cfg)
		case modePHD:
			f, n = runPHD(ctx, st, client, cfg)
		case modeNotices:
			f, n = runNotices(ctx, st, cfg)
		}
		failed = append(failed, f...)
		total += n
	}
	if !cfg.dryRun && len(failed) < total {
		if os.Getenv("REVALIDATION_URL") == "" || os.Getenv("REVALIDATION_SECRET") == "" {
			log.Printf("ownership: REVALIDATION_URL/REVALIDATION_SECRET not set; pages refresh on their TTLs")
		} else {
			revalidate(ctx, cfg.rvWait, platform.PingRevalidate)
		}
	}
	return outcome(failed, total)
}

// revalidate waits out the API cache, then busts the web tier's ownership
// pages and their KV entries. A cancelled wait skips the ping: the rows are
// stored, and the pages self-heal on their TTLs.
func revalidate(ctx context.Context, wait time.Duration, ping func(platform.RevalidateRequest)) {
	if wait > 0 {
		log.Printf("ownership: waiting %s for the API's ownership cache to turn over before revalidating", wait)
		t := time.NewTimer(wait)
		defer t.Stop()
		select {
		case <-ctx.Done():
			log.Printf("ownership: revalidation skipped (%v); pages self-heal on their TTLs", ctx.Err())
			return
		case <-t.C:
		}
	}
	ping(platform.RevalidateRequest{Reason: "ownership", Tag: "ownership", Flush: "ownership"})
}

// defaultDryRun is true unless OWNERSHIP_DRY_RUN=false or the global
// -dry-run says otherwise: the scheduled job sets the variable, a hand run
// writes nothing until asked to.
func defaultDryRun(global bool) bool {
	if global {
		return true
	}
	return !strings.EqualFold(strings.TrimSpace(os.Getenv("OWNERSHIP_DRY_RUN")), "false")
}

// outcome turns the failed sources into the exit contract.
func outcome(failed []string, total int) error {
	switch {
	case len(failed) == 0:
		return nil
	case len(failed) >= total:
		return fmt.Errorf("ownership: DOWN all %d sources failed: %v", total, failed)
	default:
		return &runner.ExitCodeError{Code: exitCodeDegraded,
			Err: fmt.Errorf("ownership: DEGRADED %d/%d sources failed: %v", len(failed), total, failed)}
	}
}

func runRegistry(ctx context.Context, st *pgStore, cfg config) ([]string, int) {
	if err := validateRegistry(registry); err != nil {
		log.Printf("ownership registry: %v", err)
		return []string{"registry"}, 1
	}
	if cfg.dryRun {
		log.Printf("DRY-RUN registry: %d institutions", len(registry))
		return nil, 1
	}
	n, err := st.SyncRegistry(ctx, registry)
	if err != nil {
		log.Printf("ownership registry: %v", err)
		return []string{"registry"}, 1
	}
	moved, err := st.RelinkNotices(ctx)
	if err != nil {
		log.Printf("ownership registry: re-linking notices: %v", err)
		return []string{"registry"}, 1
	}
	log.Printf("ownership registry: %d institutions synced, %d notices re-linked", n, moved)
	return nil, 1
}

func loadCodes(ctx context.Context, st *pgStore) (codeSet, error) {
	companies, err := st.Companies(ctx)
	if err != nil {
		return nil, err
	}
	if len(companies) == 0 {
		return nil, errors.New(`no companies in "company-metadata"`)
	}
	return codeSet(companies), nil
}

func runFunds(ctx context.Context, st *pgStore, client *http.Client, cfg config) ([]string, int) {
	rows, errs := fetchFundRegisters(ctx, client)
	var failed []string
	for _, src := range []string{"apra", "asx"} {
		if err := errs[src]; err != nil {
			log.Printf("ownership funds %s: %v", src, err)
			failed = append(failed, "funds:"+src)
			continue
		}
		funds := rows[src]
		linked := 0
		for _, f := range funds {
			if f.InstitutionSlug != "" {
				linked++
			}
		}
		if cfg.dryRun {
			log.Printf("DRY-RUN funds %s: %d products (%d linked to an institution)", src, len(funds), linked)
			continue
		}
		if err := st.SaveFunds(ctx, funds); err != nil {
			log.Printf("ownership funds %s: %v", src, err)
			failed = append(failed, "funds:"+src)
			continue
		}
		log.Printf("ownership funds %s: %d products stored (%d linked to an institution)", src, len(funds), linked)
	}
	return failed, 2
}

func runETF(ctx context.Context, st *pgStore, client *http.Client, cfg config) ([]string, int) {
	codes, err := loadCodes(ctx, st)
	if err != nil {
		log.Printf("ownership etf: %v", err)
		return []string{"etf"}, 1
	}
	var failed []string
	for _, src := range etfSources {
		if ctx.Err() != nil {
			return append(failed, "etf:"+src.Code), len(etfSources)
		}
		snap, err := fetchETF(ctx, client, src, codes)
		if err == nil && len(snap.Holdings) == 0 {
			err = fmt.Errorf("no ASX holdings among %d rows", snap.RowsTotal)
		}
		if err != nil {
			log.Printf("ownership etf %s: %v", src.Code, err)
			failed = append(failed, "etf:"+src.Code)
			continue
		}
		if cfg.dryRun {
			log.Printf("DRY-RUN etf %s as at %s: %d of %d rows are ASX stocks, %d identifiers", src.Code, snap.AsAt,
				len(snap.Holdings), snap.RowsTotal, len(snap.Identifiers))
			continue
		}
		n, err := st.SaveSnapshot(ctx, snap)
		if err == nil && len(snap.Identifiers) > 0 {
			err = st.SaveIdentifiers(ctx, snap.Identifiers, "etf:"+src.Code)
		}
		if err != nil {
			log.Printf("ownership etf %s: %v", src.Code, err)
			failed = append(failed, "etf:"+src.Code)
			continue
		}
		log.Printf("ownership etf %s as at %s: %d holdings stored, %d identifiers", src.Code, snap.AsAt, n, len(snap.Identifiers))
	}
	return failed, len(etfSources)
}

func runPHD(ctx context.Context, st *pgStore, client *http.Client, cfg config) ([]string, int) {
	codes, err := loadCodes(ctx, st)
	if err != nil {
		log.Printf("ownership phd: %v", err)
		return []string{"phd"}, 1
	}
	ids, err := st.Identifiers(ctx)
	if err != nil {
		log.Printf("ownership phd: loading identifiers: %v", err)
		return []string{"phd"}, 1
	}
	var failed []string
	now := time.Now().UTC()
	for _, src := range phdSources {
		if ctx.Err() != nil {
			return append(failed, "phd:"+src.Institution), len(phdSources)
		}
		snap, err := fetchPHD(ctx, client, src, codes, ids, now)
		if err == nil && len(snap.Holdings) == 0 {
			err = fmt.Errorf("no ASX holdings among %d rows", snap.RowsTotal)
		}
		if err != nil {
			log.Printf("ownership phd %s: %v", src.Institution, err)
			failed = append(failed, "phd:"+src.Institution)
			continue
		}
		methods := map[string]int{}
		for _, h := range snap.Holdings {
			methods[h.Match]++
		}
		if cfg.dryRun {
			log.Printf("DRY-RUN phd %s %q as at %s: %d ASX stocks of %d rows %v", src.Institution, src.Option, snap.AsAt,
				len(snap.Holdings), snap.RowsTotal, methods)
			continue
		}
		n, err := st.SaveSnapshot(ctx, snap)
		if err != nil {
			log.Printf("ownership phd %s: %v", src.Institution, err)
			failed = append(failed, "phd:"+src.Institution)
			continue
		}
		log.Printf("ownership phd %s %q as at %s: %d ASX stocks stored of %d rows %v", src.Institution, src.Option, snap.AsAt,
			n, snap.RowsTotal, methods)
	}
	return failed, len(phdSources)
}

func runNotices(ctx context.Context, st *pgStore, cfg config) ([]string, int) {
	extractor := childExtractor{pdfs: pdfchild.NewReader(PDFLayoutMode, int64(cfg.childMB)<<20)}
	pass := &noticePass{
		store: st, pdfs: reportextract.NewAnnouncementTextFetcher(), extractor: extractor,
		workers: cfg.workers, delay: cfg.delay, dryRun: cfg.dryRun, logf: log.Printf,
	}
	res, err := pass.run(ctx, cfg.limit, cfg.since)
	keys := make([]string, 0, len(res.Outcomes))
	for k := range res.Outcomes {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var parts []string
	for _, k := range keys {
		parts = append(parts, fmt.Sprintf("%s=%d", k, res.Outcomes[k]))
	}
	log.Printf("ownership notices: selected %d, parsed %d [%s]", res.Selected, res.Parsed, strings.Join(parts, " "))
	if err != nil {
		log.Printf("ownership notices: %v", err)
		return []string{"notices"}, 1
	}
	// A run where most downloads failed is an ASX block, not a quiet day.
	if res.Selected >= 20 && res.Outcomes[outcomeFetchError]*2 > res.Selected {
		log.Printf("ownership notices: %d of %d downloads failed", res.Outcomes[outcomeFetchError], res.Selected)
		return []string{"notices"}, 1
	}
	return nil, 1
}

// validateRegistry refuses a registry with a duplicate slug or alias, or an
// unknown kind: an alias two institutions share would assign one holder's
// notices to whichever sorts first.
func validateRegistry(insts []Institution) error {
	kinds := map[Kind]bool{KindSuperFund: true, KindIndexManager: true, KindHedgeFund: true, KindActiveManager: true,
		KindBankBroker: true, KindSovereignPublic: true, KindInsurer: true, KindPrivateEquity: true, KindCorporate: true, KindOther: true}
	slugs := map[string]bool{}
	aliases := map[string]string{}
	for _, in := range insts {
		if in.Slug == "" || in.Name == "" {
			return fmt.Errorf("institution %+v has no slug or name", in)
		}
		if slugs[in.Slug] {
			return fmt.Errorf("duplicate slug %q", in.Slug)
		}
		slugs[in.Slug] = true
		if !kinds[in.Kind] {
			return fmt.Errorf("%s: unknown kind %q", in.Slug, in.Kind)
		}
		if len(in.Aliases) == 0 {
			return fmt.Errorf("%s: no aliases", in.Slug)
		}
		for _, a := range in.Aliases {
			n := normalizeName(a)
			if n != a {
				return fmt.Errorf("%s: alias %q is not normalised (want %q)", in.Slug, a, n)
			}
			if other, ok := aliases[n]; ok {
				return fmt.Errorf("alias %q is on both %s and %s", n, other, in.Slug)
			}
			aliases[n] = in.Slug
		}
	}
	// A group is one level deep, and names an institution on the map.
	groups := map[string]string{}
	for _, in := range insts {
		groups[in.Slug] = in.Group
	}
	for _, in := range insts {
		if in.Group == "" {
			continue
		}
		parentGroup, ok := groups[in.Group]
		switch {
		case !ok:
			return fmt.Errorf("%s: group %q is not on the map", in.Slug, in.Group)
		case in.Group == in.Slug || parentGroup != "":
			return fmt.Errorf("%s: group %q must be a top-level institution", in.Slug, in.Group)
		}
	}
	return nil
}
