package shorts

// The OPERATOR read/write path for the register security backlog.
//
// WHAT THIS IS FOR. §6.1's item-1 gate reads 51.18% (1,174 / 2,294), and
// §8.19.1 established the denominator is `entity_kind='listed'` — a bucket the
// resolver assigns BY DEFAULT to anything it cannot otherwise explain. So a
// declared name leaves the backlog two ways, and only one of them is a match:
//
//	resolve to a code    -> numerator up, a real new published link
//	classify honestly    -> denominator down, an explained failure
//
// Both are human decisions and both have exactly ONE destination:
// register_security_aliases. aph_resolve.go:loadRegisterSecurityAliases reads
// that table and nothing else, so a row there is the single control surface.
// Nothing in this file writes register_item_securities directly — those rows are
// rebuilt from scratch by every `-mode register-resolve` (000096:346-348), so a
// hand-set value vanishes and the operator re-fixes the same row forever without
// knowing why (§7.2 item 5).
//
// NOTHING HERE PUBLISHES ANYTHING BY ITSELF. A decision changes what the NEXT
// resolve produces. That is deliberate: it keeps one code path between a curated
// alias and a published fact, and that path is already tested.

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"
)

// registerReviewTickerStopwords are codes that read like a ticker but are
// overwhelmingly ordinary words in this corpus. Resolving a candidate ONTO one
// of these is how ten members were once published as holding a fund none of them
// had declared: ETF is UBS IQ MSCI Australia ETF, and every fund name ending in
// "ETF" resolved to it.
//
// THIS IS A MIRROR of influence.tickerStopwords in the jobs module, which is a
// separate Go module. register_review_stopwords_test.go reads that file from
// disk and asserts the two are identical, so the copy cannot drift silently —
// the same defect class as the entity_kind default that was fixed in three
// layers and still served from the fourth.
var registerReviewTickerStopwords = map[string]bool{
	"ETF": true, "REIT": true, "LIC": true, "FUND": true, "TRUST": true,
	"LTD": true, "INC": true, "PLC": true, "PTY": true, "SMSF": true,
	"AUD": true, "USD": true, "NIL": true, "ORD": true, "FPO": true,
	"SHARES": true, "UNITS": true, "GROUP": true, "BANK": true,
	"USA": true, "SELF": true, "SPOUSE": true, "ACN": true, "ABN": true,
	"QLD": true, "NSW": true, "VIC": true, "TAS": true, "ACT": true, "NZL": true,
	"AND": true, "FOR": true, "ONE": true, "TWO": true, "ALL": true, "ARE": true,
	"HAS": true, "CAN": true, "ICE": true, "VAN": true, "JAY": true, "HUB": true,
	"DEV": true, "DNA": true, "EMU": true, "ZIP": true, "AUST": true,
	"HOME": true, "CASH": true, "LAND": true, "SUPER": true,
}

// maxSamplesPerCandidate caps how many real declarations the console shows per
// candidate. Enough to see the spread of spellings and holders; few enough that
// the card stays one screen and the reviewer actually reads them.
const maxSamplesPerCandidate = 6

// SecurityQueueRow is one undecided declared name plus its blast radius.
type SecurityQueueRow struct {
	CandidateNorm string
	Example       string
	Occurrences   int32
	// Counted in NAMED PEOPLE, because that is what a wrong call costs.
	People      int32
	Items       []int32
	Parliaments []int32
	EntityKinds []string
	// The subset of Occurrences inside the §6.1 item-1 denominator.
	GateRows  int32
	SkipCount int32

	Samples  []*DeclaredSampleRow
	Proposal *AliasProposalRow
}

// DeclaredSampleRow is one real row the candidate came from. The reviewer judges
// from these, never from the normalised token.
type DeclaredSampleRow struct {
	DeclaredText   string
	PoliticianName string
	PoliticianSlug string
	ItemNo         int32
	Parliament     int32
	SourceURL      string
}

// AliasProposalRow is the model's suggestion, shown WITH the shortlist it chose
// from — a proposal without its alternatives is not reviewable.
type AliasProposalRow struct {
	ProposedStockCode   string
	ProposedCompanyName string
	Confidence          float64
	Rationale           string
	Model               string
	Status              string
	Shortlist           []*RegisterListingRow
}

// RegisterListingRow is one ASX company as the reviewer sees it.
type RegisterListingRow struct {
	StockCode    string
	CompanyName  string
	ExistingUses int32
	IsStopword   bool
}

// RegisterCoverageRow carries the gate WITH its method, never as a bare number.
type RegisterCoverageRow struct {
	Resolved          int32
	ListedCandidates  int32
	GatePercent       float64
	BacklogCandidates int32
	BacklogRows       int32
	ClassifiedOut     int32
	Method            string
}

// coverageMethod travels with every figure. §8.19.1: a percentage that moves
// 30.66% -> 49.89% -> ~80% with the numerator frozen is measuring our ability to
// EXPLAIN failures, not to RESOLVE them, and it must never be quoted bare.
const coverageMethod = "resolved / entity_kind='listed' item-1 candidates. " +
	"The denominator is a DEFAULT bucket: the resolver assigns 'listed' to any candidate it " +
	"cannot otherwise explain, so classifying the correctly-unresolvable backlog raises this " +
	"figure with no new matches. Report with the band and the method, never as 'the gate is met'."

// ListSecurityReviewQueue returns undecided declared names, biggest fanout
// first, with the real declarations behind each one.
func (s *postgresStore) ListSecurityReviewQueue(limit, offset int32, gateOnly bool) ([]*SecurityQueueRow, int32, int32, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()

	if limit <= 0 || limit > 100 {
		limit = 25
	}
	if offset < 0 {
		offset = 0
	}

	gateFilter := ""
	if gateOnly {
		gateFilter = "WHERE q.gate_rows > 0"
	}

	// One query for the page. register_review_security_queue (000101) already
	// excludes anything register_security_aliases decides, so a decided
	// candidate leaves the queue with no second state store to keep in sync.
	q := fmt.Sprintf(`
		SELECT q.candidate_norm, q.example, q.occurrences, q.people,
		       q.items, q.parliaments, q.entity_kinds, q.gate_rows,
		       COALESCE(sk.skip_count, 0)
		FROM register_review_security_queue q
		LEFT JOIN register_review_skips sk ON sk.candidate_norm = q.candidate_norm
		%s
		ORDER BY COALESCE(sk.skip_count, 0) ASC, q.occurrences DESC, q.people DESC, q.candidate_norm
		LIMIT $1 OFFSET $2`, gateFilter)

	rows, err := s.db.Query(ctx, q, limit, offset)
	if err != nil {
		return nil, 0, 0, fmt.Errorf("list security review queue: %w", err)
	}
	defer rows.Close()

	var out []*SecurityQueueRow
	var norms []string
	for rows.Next() {
		var r SecurityQueueRow
		if err := rows.Scan(&r.CandidateNorm, &r.Example, &r.Occurrences, &r.People,
			&r.Items, &r.Parliaments, &r.EntityKinds, &r.GateRows, &r.SkipCount); err != nil {
			return nil, 0, 0, fmt.Errorf("scan queue row: %w", err)
		}
		out = append(out, &r)
		norms = append(norms, r.CandidateNorm)
	}
	if err := rows.Err(); err != nil {
		return nil, 0, 0, err
	}

	byNorm := make(map[string]*SecurityQueueRow, len(out))
	for _, r := range out {
		byNorm[r.CandidateNorm] = r
	}
	if len(norms) > 0 {
		if err := s.attachDeclaredSamples(ctx, norms, byNorm); err != nil {
			return nil, 0, 0, err
		}
		if err := s.attachAliasProposals(ctx, norms, byNorm); err != nil {
			return nil, 0, 0, err
		}
	}

	var totalCandidates, totalRows int32
	if err := s.db.QueryRow(ctx, `
		SELECT count(*), COALESCE(sum(occurrences), 0) FROM register_review_security_queue`).
		Scan(&totalCandidates, &totalRows); err != nil {
		return nil, 0, 0, fmt.Errorf("queue totals: %w", err)
	}

	return out, totalCandidates, totalRows, nil
}

// attachDeclaredSamples loads the real declarations behind the page's
// candidates. One query for the whole page rather than one per card: the N+1
// form is what makes a reviewer wait, and a reviewer who waits skips.
func (s *postgresStore) attachDeclaredSamples(ctx context.Context, norms []string, byNorm map[string]*SecurityQueueRow) error {
	rows, err := s.db.Query(ctx, `
		SELECT s.candidate_norm, i.declared_text,
		       COALESCE(p.display_name, ''), COALESCE(p.slug, ''),
		       i.item_no, COALESCE(st.parliament, 0), i.source_url
		FROM register_item_securities s
		JOIN register_declared_items i  ON i.id = s.item_id
		JOIN register_statements     st ON st.id = i.statement_id
		LEFT JOIN politicians        p  ON p.id = i.politician_id
		WHERE s.candidate_norm = ANY($1)
		  AND s.resolution_status IN ('unmatched', 'ambiguous')
		ORDER BY s.candidate_norm, st.parliament DESC NULLS LAST, i.declared_text`, norms)
	if err != nil {
		return fmt.Errorf("load declared samples: %w", err)
	}
	defer rows.Close()

	// Distinct on the pair a reviewer actually distinguishes: the same wording
	// declared by three members is three rows worth seeing (it is the blast
	// radius made concrete), but the identical row repeated across parliaments
	// is not.
	seen := map[string]bool{}
	for rows.Next() {
		var norm string
		var sample DeclaredSampleRow
		if err := rows.Scan(&norm, &sample.DeclaredText, &sample.PoliticianName,
			&sample.PoliticianSlug, &sample.ItemNo, &sample.Parliament, &sample.SourceURL); err != nil {
			return fmt.Errorf("scan declared sample: %w", err)
		}
		parent, ok := byNorm[norm]
		if !ok || len(parent.Samples) >= maxSamplesPerCandidate {
			continue
		}
		key := norm + "\x00" + sample.PoliticianSlug + "\x00" + sample.DeclaredText
		if seen[key] {
			continue
		}
		seen[key] = true
		parent.Samples = append(parent.Samples, &sample)
	}
	return rows.Err()
}

func (s *postgresStore) attachAliasProposals(ctx context.Context, norms []string, byNorm map[string]*SecurityQueueRow) error {
	rows, err := s.db.Query(ctx, `
		SELECT candidate_norm, COALESCE(proposed_stock_code, ''), proposed_company_name,
		       COALESCE(confidence, 0), rationale, model, status, shortlist
		FROM register_alias_proposals
		WHERE candidate_norm = ANY($1)`, norms)
	if err != nil {
		return fmt.Errorf("load alias proposals: %w", err)
	}
	defer rows.Close()

	for rows.Next() {
		var norm string
		var p AliasProposalRow
		var shortlist []struct {
			Code string `json:"code"`
			Name string `json:"name"`
		}
		if err := rows.Scan(&norm, &p.ProposedStockCode, &p.ProposedCompanyName,
			&p.Confidence, &p.Rationale, &p.Model, &p.Status, &shortlist); err != nil {
			return fmt.Errorf("scan alias proposal: %w", err)
		}
		for _, l := range shortlist {
			p.Shortlist = append(p.Shortlist, &RegisterListingRow{
				StockCode:   l.Code,
				CompanyName: l.Name,
				IsStopword:  registerReviewTickerStopwords[strings.ToUpper(l.Code)],
			})
		}
		if parent, ok := byNorm[norm]; ok {
			parent.Proposal = &p
		}
	}
	return rows.Err()
}

// SearchRegisterListings backs the resolve box. Reads "company-metadata" only —
// the reviewer picks from real listings and may not type a code.
func (s *postgresStore) SearchRegisterListings(query string, limit int32) ([]*RegisterListingRow, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	query = strings.TrimSpace(query)
	if query == "" {
		return nil, nil
	}
	if limit <= 0 || limit > 50 {
		limit = 15
	}

	// existing_uses is the count of register candidates ALREADY resolved to this
	// code. A code with a large existing footprint is usually the right answer;
	// one with none is worth a second look before it lands on a named person.
	rows, err := s.db.Query(ctx, `
		SELECT m.stock_code, m.company_name,
		       COALESCE((SELECT count(*) FROM register_item_securities r
		                 WHERE r.stock_code = m.stock_code AND r.resolution_status = 'resolved'), 0)
		FROM "company-metadata" m
		WHERE m.stock_code IS NOT NULL AND btrim(m.stock_code) <> ''
		  AND m.company_name IS NOT NULL AND btrim(m.company_name) <> ''
		  AND (upper(m.stock_code) = upper($1)
		       OR upper(m.stock_code) LIKE upper($1) || '%'
		       OR m.company_name ILIKE '%' || $1 || '%')
		ORDER BY (upper(m.stock_code) = upper($1)) DESC,
		         (upper(m.company_name) LIKE upper($1) || '%') DESC,
		         length(m.company_name), m.stock_code
		LIMIT $2`, query, limit)
	if err != nil {
		return nil, fmt.Errorf("search listings: %w", err)
	}
	defer rows.Close()

	var out []*RegisterListingRow
	for rows.Next() {
		var l RegisterListingRow
		if err := rows.Scan(&l.StockCode, &l.CompanyName, &l.ExistingUses); err != nil {
			return nil, err
		}
		l.IsStopword = registerReviewTickerStopwords[strings.ToUpper(l.StockCode)]
		out = append(out, &l)
	}
	return out, rows.Err()
}

// ErrRegisterListingUnknown is returned when a resolve names a code that is not
// a real listing. The client may not invent a code, and the server does not
// trust it not to.
var ErrRegisterListingUnknown = errors.New("stock code is not a known ASX listing")

// ErrRegisterStopwordUnconfirmed is returned when a resolve targets a
// tickerStopwords code without the second confirmation.
var ErrRegisterStopwordUnconfirmed = errors.New("stock code is a stopword ticker and needs a second confirmation")

// DecideSecurityCandidate records ONE human decision about ONE declared name.
//
// Everything happens in one transaction: the alias row IS the decision, and the
// proposal bookkeeping beside it must not be able to disagree with it.
func (s *postgresStore) DecideSecurityCandidate(
	candidateNorm, decision, stockCode, aliasKind, note, reviewer string, stopwordConfirmed bool,
) (int32, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	candidateNorm = strings.TrimSpace(candidateNorm)
	if candidateNorm == "" {
		return 0, errors.New("candidate_norm is required")
	}
	reviewer = strings.TrimSpace(reviewer)
	if reviewer == "" {
		// curated_by is the evidence that a human made this call. A decision
		// without one is indistinguishable from a machine's.
		return 0, errors.New("reviewer is required")
	}

	// A skip writes NO alias — that is the whole point, it is the "I do not
	// know" answer — so it never touches the resolver's input.
	if decision == "skip" {
		_, err := s.db.Exec(ctx, `
			INSERT INTO register_review_skips (candidate_norm, skip_count, last_skipped_by, last_skipped_at)
			VALUES ($1, 1, $2, now())
			ON CONFLICT (candidate_norm) DO UPDATE
			SET skip_count = register_review_skips.skip_count + 1,
			    last_skipped_by = EXCLUDED.last_skipped_by,
			    last_skipped_at = now()`, candidateNorm, reviewer)
		return 0, err
	}

	resolution, kind, err := aliasWriteFor(decision, aliasKind)
	if err != nil {
		return 0, err
	}

	var displayName string
	if resolution == "resolved" {
		stockCode = strings.ToUpper(strings.TrimSpace(stockCode))
		if stockCode == "" {
			return 0, errors.New("a resolve decision requires a stock code")
		}
		// VALIDATE, never trust. The public gate lets a curated_alias publish a
		// live /shorts/<code> link against a named person; a typo'd or invented
		// code becomes a wrong fact about them.
		if err := s.db.QueryRow(ctx,
			`SELECT company_name FROM "company-metadata" WHERE upper(stock_code) = $1`,
			stockCode).Scan(&displayName); err != nil {
			return 0, fmt.Errorf("%w: %s", ErrRegisterListingUnknown, stockCode)
		}
		if registerReviewTickerStopwords[stockCode] && !stopwordConfirmed {
			return 0, fmt.Errorf("%w: %s", ErrRegisterStopwordUnconfirmed, stockCode)
		}
	} else {
		stockCode = ""
	}

	tx, err := s.db.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var codeArg any
	if stockCode != "" {
		codeArg = stockCode
	}

	// ON CONFLICT DO UPDATE, not DO NOTHING: a reviewer correcting their own
	// earlier call must win, and the row records who made the current one.
	if _, err := tx.Exec(ctx, `
		INSERT INTO register_security_aliases
			(alias_norm, stock_code, alias_kind, resolution, display_name, note, curated_by, curated_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, now())
		ON CONFLICT (alias_norm) DO UPDATE
		SET stock_code = EXCLUDED.stock_code, alias_kind = EXCLUDED.alias_kind,
		    resolution = EXCLUDED.resolution, display_name = EXCLUDED.display_name,
		    note = EXCLUDED.note, curated_by = EXCLUDED.curated_by, curated_at = now()`,
		candidateNorm, codeArg, kind, resolution, displayName, strings.TrimSpace(note), reviewer); err != nil {
		return 0, fmt.Errorf("write curated alias: %w", err)
	}

	// Bookkeeping on the model's proposal, if it made one. It is marked
	// 'confirmed' ONLY when the human landed on the same code the model
	// proposed; anything else is a rejection of that proposal, including a
	// resolve to a DIFFERENT code. Calling that "confirmed" would credit the
	// model with an answer it did not give.
	proposalStatus := "rejected"
	if resolution == "resolved" {
		var proposed string
		err := tx.QueryRow(ctx,
			`SELECT COALESCE(proposed_stock_code, '') FROM register_alias_proposals WHERE candidate_norm = $1`,
			candidateNorm).Scan(&proposed)
		if err == nil && strings.EqualFold(proposed, stockCode) {
			proposalStatus = "confirmed"
		}
	}
	if _, err := tx.Exec(ctx, `
		UPDATE register_alias_proposals
		SET status = $2, reviewed_by = $3, reviewed_at = now()
		WHERE candidate_norm = $1 AND status = 'proposed'`,
		candidateNorm, proposalStatus, reviewer); err != nil {
		return 0, fmt.Errorf("update proposal status: %w", err)
	}

	// How many rows the next resolve will change. Counted BEFORE commit from the
	// same transaction so the number the operator is shown is the number that
	// existed when they decided.
	var affected int32
	if err := tx.QueryRow(ctx, `
		SELECT count(*) FROM register_item_securities
		WHERE candidate_norm = $1 AND resolution_status IN ('unmatched', 'ambiguous')`,
		candidateNorm).Scan(&affected); err != nil {
		return 0, err
	}

	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	return affected, nil
}

// aliasWriteFor maps a console decision onto the alias table's own CHECK
// vocabulary. The mapping is exhaustive and closed: an unknown decision is an
// error, never a default, because the default would be a published claim.
func aliasWriteFor(decision, aliasKind string) (resolution, kind string, err error) {
	switch decision {
	case "resolved":
		kind = aliasKind
		switch kind {
		case "equity", "etf", "lic", "managed_fund":
		default:
			// Descriptive only — the resolver reads `resolution` — so an
			// unspecified kind is not an error, but it must not be invented as
			// something more specific than 'equity'.
			kind = "equity"
		}
		return "resolved", kind, nil
	case "unlisted_fund":
		return "unlisted_fund", "managed_fund", nil
	case "not_a_security":
		return "not_a_security", "noise", nil
	case "foreign":
		return "foreign", "foreign", nil
	default:
		// 'analyst_fuzzy' and anything else land here. The public gate forbids a
		// fuzzy match from ever being 'resolved', and learning that from a CHECK
		// violation after deciding about a named person is too late (§7.2.6).
		return "", "", fmt.Errorf("unknown decision %q", decision)
	}
}

// UndoSecurityDecision deletes the alias row, returning every candidate it
// covered to 'unmatched' — the honest pre-decision state.
func (s *postgresStore) UndoSecurityDecision(candidateNorm string) (bool, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	tag, err := s.db.Exec(ctx,
		`DELETE FROM register_security_aliases WHERE alias_norm = $1`, strings.TrimSpace(candidateNorm))
	if err != nil {
		return false, fmt.Errorf("undo decision: %w", err)
	}
	return tag.RowsAffected() > 0, nil
}

// GetRegisterCoverageStats reports the §6.1 gate WITH its method attached.
func (s *postgresStore) GetRegisterCoverageStats() (*RegisterCoverageRow, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	var r RegisterCoverageRow
	// classified_out counts item-1 candidates a HUMAN explicitly moved out of
	// the 'listed' bucket. It is reported beside the ratio so the honest half of
	// any movement is visible rather than folded into a single percentage.
	if err := s.db.QueryRow(ctx, `
		SELECT
		  (SELECT count(*) FILTER (WHERE s.resolution_status = 'resolved')
		     FROM register_item_securities s JOIN register_declared_items i ON i.id = s.item_id
		    WHERE i.item_no = 1 AND s.entity_kind = 'listed'),
		  (SELECT count(*)
		     FROM register_item_securities s JOIN register_declared_items i ON i.id = s.item_id
		    WHERE i.item_no = 1 AND s.entity_kind = 'listed'),
		  (SELECT count(*) FROM register_review_security_queue),
		  (SELECT COALESCE(sum(occurrences), 0) FROM register_review_security_queue),
		  (SELECT count(*)
		     FROM register_item_securities s
		     JOIN register_declared_items i ON i.id = s.item_id
		     JOIN register_security_aliases a ON a.alias_norm = s.candidate_norm
		    WHERE i.item_no = 1 AND a.resolution <> 'resolved')`).
		Scan(&r.Resolved, &r.ListedCandidates, &r.BacklogCandidates, &r.BacklogRows, &r.ClassifiedOut); err != nil {
		return nil, fmt.Errorf("coverage stats: %w", err)
	}
	if r.ListedCandidates > 0 {
		r.GatePercent = float64(r.Resolved) * 100.0 / float64(r.ListedCandidates)
	}
	r.Method = coverageMethod
	return &r, nil
}
