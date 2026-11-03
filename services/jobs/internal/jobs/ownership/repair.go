package ownership

import (
	"context"
	"fmt"
	"log"

	"github.com/castlemilk/shorted.com.au/services/jobs/internal/platform"
)

// The placeholder repair. The notices pass withholds a section 1 name that
// points elsewhere ("SEE ANNEXURE 1") as no_holder. A notice parsed before that
// gate kept its holder row, and its parsed attempt is never read again, so no
// pass removes the row. This mode lists those rows and removes them, and the
// next notices run reads each notice again and withholds it.
//
// The stored name is the tidied section 1 text, so it cannot show whether the
// gate would read the section 1 name as an institution's. The holder_key can: a
// key that is an institution's slug means the pass resolved the name to that
// institution, and the gate keeps such a name. Those rows are listed with a note
// and never removed. Removing one would bring an earlier holding back as current
// in v_substantial_holdings_current, and the next run would store it again.

// storedNotice is one substantial_holder_notices row, as the repair reads it.
type storedNotice struct {
	URL         string
	StockCode   string
	HolderKey   string
	HolderName  string
	PresentPct  *float64
	AnnouncedOn string
	Form        string
	Ceased      bool
}

// placeholderRow is a stored notice whose holder name the placeholder rule
// withholds, with the rule's reason. Kept is set for a row keyed to a curated
// institution: it is listed for the operator and never removed.
type placeholderRow struct {
	storedNotice
	Reason string
	Kept   bool
}

// repairStore is the repair's database: the stored notices to judge, and the
// removal of the ones it withholds, in one transaction.
type repairStore interface {
	StoredNotices(ctx context.Context) ([]storedNotice, error)
	RemoveNoticesAndAttempts(ctx context.Context, urls []string) (notices, attempts int64, err error)
}

// placeholderRows returns the stored notices whose holder name the placeholder
// rule withholds, judged by placeholderHolder: the parser's own judgment, so the
// repair and the gate apply one rule. A notice with no holder name is no
// placeholder: the parser's fallbacks name its holder.
func placeholderRows(rows []storedNotice) []placeholderRow {
	var out []placeholderRow
	for _, r := range rows {
		if _, why := placeholderHolder(r.HolderName); why != "" {
			out = append(out, placeholderRow{storedNotice: r, Reason: why, Kept: institutionKey(r.HolderKey)})
		}
	}
	return out
}

// institutionKey reports whether a holder_key is a curated institution's slug,
// the key the pass gives a holder whose name resolves to that institution. The
// other keys are "name:" for an unmapped holder and "asx:" for a listed company.
func institutionKey(key string) bool {
	return institutionBySlug(key) != nil
}

// placeholderLine is one row of the dry-run listing, without its log prefix. It
// carries what an operator judges a row by: the stock, the holder's name and key,
// the form, whether the holding ceased, the voting power at four places (so
// SYR's 6.0049% is not shown as 6.00%), the announcement date, the URL and the
// rule's reason. A kept row adds a note saying why it is kept. A ceased row adds
// one too: removing a ceased notice brings the holder's earlier holding back as
// current in v_substantial_holdings_current, so an operator judges it first.
func placeholderLine(p placeholderRow) string {
	line := fmt.Sprintf("%s %q key=%s form=%s ceased=%t present=%s announced=%s %s (%s)",
		p.StockCode, p.HolderName, p.HolderKey, p.Form, p.Ceased, fmtPctExact(p.PresentPct), p.AnnouncedOn, p.URL, p.Reason)
	switch {
	case p.Kept:
		line += " NOTE: keyed to institution " + p.HolderKey + ", so kept, not removed: its name resolves to it, and a re-read would store it again"
		if p.Ceased {
			line += "; removing a ceased notice would bring an earlier holding back as current"
		}
	case p.Ceased:
		line += " NOTE: ceased, so removing it can bring an earlier holding for this key back as current in v_substantial_holdings_current"
	}
	return line
}

// fmtPctExact prints a stored voting power at four places, the precision the
// notices state their figures to. "-" when none is stored: a 605 often states none.
func fmtPctExact(p *float64) string {
	if p == nil {
		return "-"
	}
	return fmt.Sprintf("%.4f%%", *p)
}

// repairPlaceholders is -mode repair-placeholders. It lists the stored notices
// whose holder name the placeholder rule withholds, one line each, and with
// -apply removes the ones not keyed to an institution, with their attempts, so
// the next notices run reads them again. -apply is the mode's own consent, and
// the job's dry-run convention still holds (a hand run writes nothing until
// -dry-run=false), so a removal needs both. ping is the web tier's revalidation,
// sent once after a removal.
func repairPlaceholders(ctx context.Context, st repairStore, cfg config, ping func(platform.RevalidateRequest)) error {
	if cfg.apply && cfg.dryRun {
		// A request to remove rows that writes nothing is a failure, not a quiet
		// success, so an automated caller sees that it did not happen.
		return fmt.Errorf("ownership repair-placeholders: -apply is set but -dry-run is on, so nothing was removed: list the rows without -apply, then pass -apply -dry-run=false")
	}
	rows, err := st.StoredNotices(ctx)
	if err != nil {
		return fmt.Errorf("ownership repair-placeholders: reading stored notices: %w", err)
	}
	found := placeholderRows(rows)
	if len(found) == 0 {
		log.Printf("ownership repair-placeholders: nothing to repair (%d stored notices checked)", len(rows))
		return nil
	}
	var urls []string
	kept := 0
	for _, p := range found {
		log.Printf("ownership repair-placeholders: %s", placeholderLine(p))
		if p.Kept {
			kept++
			continue
		}
		urls = append(urls, p.URL)
	}
	log.Printf("ownership repair-placeholders: %d of %d stored notices name a placeholder holder: %d removable, %d keyed to an institution and kept",
		len(found), len(rows), len(urls), kept)
	if len(urls) == 0 {
		log.Printf("ownership repair-placeholders: nothing to remove")
		return nil
	}
	if !cfg.apply {
		log.Printf("ownership repair-placeholders: DRY-RUN, nothing removed; pass -apply and -dry-run=false to remove the %d removable notices", len(urls))
		return nil
	}
	removedNotices, removedAttempts, err := st.RemoveNoticesAndAttempts(ctx, urls)
	if err != nil {
		return fmt.Errorf("ownership repair-placeholders: removing %d notices: %w", len(urls), err)
	}
	log.Printf("ownership repair-placeholders: removed %d notices and %d attempts; the next notices run reads them again",
		removedNotices, removedAttempts)
	// A removed notice stays on the ownership pages until their cache turns over,
	// so the revalidation waits that out, as after any run that stored rows.
	if removedNotices > 0 {
		pingRevalidate(ctx, cfg.rvWait, ping)
	}
	return nil
}
