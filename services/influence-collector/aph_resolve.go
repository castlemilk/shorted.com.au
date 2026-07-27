package main

// Resolves declared item-1 text to ASX codes.
//
// EDITORIAL (docs/influence-editorial-standards.md §2): fuzzy name matches are
// analyst-only and never public. Only three things reach a public surface —
// a human-curated alias, an ASX ticker the member wrote themselves, or an exact
// normalised name match against exactly one company. The CHECK constraint on
// register_item_securities enforces that even if a query here is wrong.
//
// The splitting work is mostly already done: the parser preserves the cell's
// physical lines, and the form lists one entity per line. What remains is
// rejecting prose, stripping qualifiers, and the match ladder.

import (
	"context"
	"fmt"
	"regexp"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// tickerInTextRe finds a parenthesised ASX-code-shaped token, e.g.
// "iShares S&P 500 ETF (IVV)" or "Betashares … Cash ETF (AAA)".
//
// ASX codes are 3 letters, sometimes with 1-2 trailing digits (A200, NDQ).
var tickerInTextRe = regexp.MustCompile(`\(([A-Z]{3}[A-Z0-9]{0,2})\)`)

// trailingTickerRe catches the un-parenthesised form: "Telstra TLS".
var trailingTickerRe = regexp.MustCompile(`\s([A-Z]{3}[A-Z0-9]{0,2})$`)

// tickerStopwords are generic security-type words that happen to BE real ASX
// codes, so a name ending in one would resolve to the wrong listing entirely.
//
// This was a live wrong-attribution bug, not a hypothetical: ETF is UBS IQ MSCI
// Australia ETF, and every fund name ending in "ETF" — "Betashares Global
// Sustainability Leaders ETF", "Australian Shares ETF" — resolved to it. Ten
// members were shown holding a fund none of them had declared. REIT (VanEck
// International REIT) and LIC (Lifestyle Communities) are the same trap.
//
// A member who genuinely holds one of these can be given a curated alias, which
// is checked first.
// Gift / travel / membership vocabulary, and bare years. These are ITEM 11-12
// content, never a listing. Anchored whole-string so a real company whose name
// merely contains one of these words is untouched ("Gift Holdings Ltd" survives).
var nonSecurityRe = regexp.MustCompile(
	`(?i)^\s*(` +
		`gifts?|hampers?|memberships?|subscriptions?|donations?|` +
		`flight\s+upgrades?|upgrades?|lounge(\s+(access|membership))?|` +
		`tickets?|complimentary\s+.*|hospitality|accommodation|` +
		`travel(\s+(costs?|expenses?))?|airfares?|sponsored\s+travel|` +
		`\d{4}|n/?a|nil|none|not\s+applicable|various|as\s+above|same\s+as\s+above` +
		`)\s*$`,
)

// The WHOLE candidate is an ASX-shaped code. ASX codes are 3 letters, with a few
// 2- and 4-character exceptions; anchored so it can never fire on a phrase.
var bareTickerRe = regexp.MustCompile(`^([A-Z0-9]{2,4})$`)

var tickerStopwords = map[string]bool{
	"ETF": true, "REIT": true, "LIC": true, "FUND": true, "TRUST": true,
	"LTD": true, "INC": true, "PLC": true, "PTY": true, "SMSF": true,
	"AUD": true, "USD": true, "NIL": true, "ORD": true, "FPO": true,
	"SHARES": true, "UNITS": true, "GROUP": true, "BANK": true,
}

// qualifierRe strips declaration bookkeeping that is not part of a name.
var qualifierRe = regexp.MustCompile(`(?i)\s*\((joint|joint with spouse|jointly|self|spouse|partner|shared|disposed[^)]*|acquired[^)]*|formerly[^)]*)\)`)

// securitySuffixRe strips share-class notation: "Far Ltd FPO" is FAR.
var securitySuffixRe = regexp.MustCompile(`(?i)\s+(FPO|FPS|CDI|STAPLED|ORD|ORDINARY)\.?$`)

// privateCompanyRe marks a line as an unlisted private entity. Its presence
// vetoes the inline-ticker path: "Gunnedah Industries (NW) Pty Ltd" must never
// resolve to a listed code that happens to share those letters.
var privateCompanyRe = regexp.MustCompile(`(?i)\bp(?:ty|/l)\b|\bproprietary\b|\bfamily trust\b|\bsuperannuation fund\b|\bsmsf\b`)

// proseRe marks a line as narrative rather than an entity name. Members write
// sentences into the cell, and the parser preserves them faithfully:
// "On the 19th of August 2025 I ceased" / "to be a shareholder of Gunnedah".
var proseRe = regexp.MustCompile(`(?i)\b(i (?:ceased|acquired|sold|hold|purchased|disposed)|shareholder of|no longer|as (?:at|per)|see (?:attached|above|below)|refer to|all (?:spouse|partner|details)|nil return|not applicable)\b`)

// maxCandidateLen rejects prose that slipped past proseRe. The longest real ASX
// company name is well under this.
const maxCandidateLen = 120

// SecurityCandidate is one entity name teased out of a declared cell.
type SecurityCandidate struct {
	Ordinal int
	Raw     string
	Norm    string
	Ticker  string // an ASX code the member stated themselves
	Private bool   // an unlisted private entity (Pty Ltd, family trust, SMSF)
	Reject  string // non-empty => not a security; carries the reason
}

// splitSecurityBlob turns a declared item-1 cell into ordered candidates.
//
// declared_lines is the primary split, because the form puts one entity per
// line. Each line is then sub-split on separators, which is where the source
// gets messy: it mixes commas AND periods, e.g.
//
//	"ANZ, Arena REIT, Beta shares Asia ETF, BHP. CBA, Cochlear, CSL."
//
// so "BHP. CBA" is two companies while "Pty. Ltd." is not a boundary.
func splitSecurityBlob(lines []string, fallback string) []SecurityCandidate {
	source := lines
	if len(source) == 0 && strings.TrimSpace(fallback) != "" {
		source = []string{fallback}
	}

	var out []SecurityCandidate
	for _, line := range source {
		for _, fragment := range splitFragments(line) {
			candidate := makeCandidate(len(out), fragment)
			if candidate.Raw == "" {
				continue
			}
			out = append(out, candidate)
		}
	}
	return out
}

// sentenceBoundaryRe splits on a period ONLY when it is followed by whitespace
// and an uppercase letter, and the preceding token is not an abbreviation.
//
// Written without lookahead: Go's regexp is RE2, so `(?=[A-Z])` does not
// compile. The uppercase letter is therefore CONSUMED by the match and handed
// back to the next fragment by rewinding one byte (ASCII, so one byte is one
// letter).
var sentenceBoundaryRe = regexp.MustCompile(`\.\s+[A-Z]`)

// abbreviations must not be treated as a fragment boundary.
var abbreviationTail = regexp.MustCompile(`(?i)\b(ltd|limited|inc|co|pty|plc|nl|corp|no|st|pte|sa|nv|ag)\.$`)

func splitFragments(line string) []string {
	line = normaliseUnicode(line)
	if line == "" {
		return nil
	}

	// Commas, semicolons and newlines are unambiguous separators.
	rough := regexp.MustCompile(`[;,\n]+`).Split(line, -1)

	var out []string
	for _, part := range rough {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		// Now consider periods, keeping abbreviations intact.
		start := 0
		for _, loc := range sentenceBoundaryRe.FindAllStringIndex(part, -1) {
			head := strings.TrimSpace(part[start : loc[0]+1])
			if abbreviationTail.MatchString(head) {
				continue
			}
			if head != "" {
				out = append(out, head)
			}
			// Rewind one byte so the uppercase letter the pattern consumed
			// starts the next fragment: "BHP. CBA" must yield "CBA", not "BA".
			start = loc[1] - 1
		}
		if tail := strings.TrimSpace(part[start:]); tail != "" {
			out = append(out, tail)
		}
	}
	return out
}

func normaliseUnicode(s string) string {
	replacer := strings.NewReplacer(
		"–", "-", "—", "-", "‘", "'", "’", "'",
		"“", `"`, "”", `"`, " ", " ",
	)
	return strings.Join(strings.Fields(replacer.Replace(s)), " ")
}

func makeCandidate(ordinal int, fragment string) SecurityCandidate {
	c := SecurityCandidate{Ordinal: ordinal, Raw: strings.TrimSpace(fragment)}
	if c.Raw == "" {
		return c
	}

	// An inline ticker is captured BEFORE qualifiers are stripped, but only when
	// the line is not an unlisted private entity.
	private := privateCompanyRe.MatchString(c.Raw)
	c.Private = private
	if !private {
		if m := tickerInTextRe.FindStringSubmatch(c.Raw); m != nil && !tickerStopwords[m[1]] {
			c.Ticker = m[1]
		}
	}

	cleaned := qualifierRe.ReplaceAllString(c.Raw, "")
	cleaned = securitySuffixRe.ReplaceAllString(strings.TrimSpace(cleaned), "")
	cleaned = strings.TrimSpace(strings.Trim(cleaned, ".,;"))

	// A candidate that is NOTHING BUT a ticker never matched, because
	// trailingTickerRe only fires on a ticker FOLLOWING other text. Members
	// routinely write the code alone — "IAG", "QBE", "TLS" — and those then fell
	// through to name matching, which cannot work: the listing is "Insurance
	// Australia Group", not "IAG". Measured after the 44P/45P backfill, bare
	// tickers were the single largest group in the item-1 unmatched pool.
	//
	// Safe because resolveSecurityCandidate only accepts a ticker that EXISTS in
	// the listings map, so a 3-letter word that is not a real code still misses.
	if c.Ticker == "" && !private {
		if m := bareTickerRe.FindStringSubmatch(cleaned); m != nil && !tickerStopwords[m[1]] {
			c.Ticker = m[1]
		}
	}

	if c.Ticker == "" && !private {
		if m := trailingTickerRe.FindStringSubmatch(cleaned); m != nil && !tickerStopwords[m[1]] {
			c.Ticker = m[1]
			cleaned = strings.TrimSpace(strings.TrimSuffix(cleaned, m[1]))
		}
	}

	switch {
	case nonSecurityRe.MatchString(cleaned):
		// Items 11 and 12 (gifts, sponsored travel) go through the same splitter
		// as item 1, so their content lands in the candidate pool. Measured after
		// the 44P/45P backfill, the top "unmatched" names were GIFT, 2017,
		// FLIGHT UPGRADE and MEMBERSHIP — none of them a security, all of them in
		// the denominator, dragging the item-1 resolution rate from 35.3% to
		// 20.3% without a single extra failure. Older parliaments carry far more
		// gift/travel text, so widening the corpus diluted the metric rather than
		// worsening it. These belong OUTSIDE the denominator, which is what
		// `resolvable = candidates - not_a_security` exists for.
		c.Reject = "not_a_security_term"
	case proseRe.MatchString(c.Raw):
		c.Reject = "prose"
	case len(c.Raw) > maxCandidateLen:
		c.Reject = "too_long"
	case len(strings.TrimSpace(cleaned)) < 2 && c.Ticker == "":
		c.Reject = "too_short"
	}

	c.Norm = normalizeEntityName(cleaned)
	if c.Norm == "" && c.Ticker == "" && c.Reject == "" {
		c.Reject = "empty_after_normalisation"
	}
	return c
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

// SecurityAlias is a curated declared-name -> code decision.
type SecurityAlias struct {
	StockCode   string
	AliasKind   string
	Resolution  string
	DisplayName string
}

// SecurityResolution is the outcome for one candidate.
type SecurityResolution struct {
	StockCode      string
	CompanyName    string
	Status         string
	MatchMethod    string
	Confidence     float64
	CandidateCount int
}

func loadRegisterSecurityAliases(ctx context.Context, pool *pgxpool.Pool) (map[string]SecurityAlias, error) {
	rows, err := pool.Query(ctx, `
		SELECT alias_norm, COALESCE(stock_code, ''), alias_kind, resolution, display_name
		FROM register_security_aliases`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := map[string]SecurityAlias{}
	for rows.Next() {
		var norm string
		var a SecurityAlias
		if err := rows.Scan(&norm, &a.StockCode, &a.AliasKind, &a.Resolution, &a.DisplayName); err != nil {
			return nil, err
		}
		out[norm] = a
	}
	return out, rows.Err()
}

// loadAmbiguousCompanyNames returns normalised names that map to MORE than one
// listing, with the count.
//
// collapseCompanyNameMappings deliberately drops those names, so without this a
// same-name trap is indistinguishable from a name we simply do not carry — and
// the curation backlog would invite someone to "fix" it with an alias guess
// instead of a human decision.
func loadAmbiguousCompanyNames(ctx context.Context, pool *pgxpool.Pool) (map[string]int, error) {
	rows, err := pool.Query(ctx, `
		SELECT `+normExpr("company_name")+` AS nname, count(DISTINCT stock_code) AS codes
		FROM "company-metadata"
		WHERE company_name IS NOT NULL AND btrim(company_name) <> ''
		  AND stock_code IS NOT NULL AND btrim(stock_code) <> ''
		GROUP BY 1
		HAVING count(DISTINCT stock_code) > 1`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := map[string]int{}
	for rows.Next() {
		var name string
		var n int
		if err := rows.Scan(&name, &n); err != nil {
			return nil, err
		}
		if name != "" {
			out[name] = n
		}
	}
	return out, rows.Err()
}

// loadStockCodes is the validation set for an inline ticker. A code the member
// wrote is only trusted once it is confirmed to be a real listing.
func loadStockCodes(ctx context.Context, pool *pgxpool.Pool) (map[string]string, error) {
	rows, err := pool.Query(ctx, `
		SELECT upper(stock_code), COALESCE(company_name, '')
		FROM "company-metadata"
		WHERE stock_code IS NOT NULL AND stock_code <> ''`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := map[string]string{}
	for rows.Next() {
		var code, name string
		if err := rows.Scan(&code, &name); err != nil {
			return nil, err
		}
		out[code] = name
	}
	return out, rows.Err()
}

// resolveSecurityCandidate applies the ladder in precedence order.
//
//  1. curated alias — a human decision outranks a coincidence
//  2. inline ticker  — the member stated the code; validated against listings
//  3. exact normalised name — one company or nothing, same rule as runMatch
//
// Anything else is unmatched or ambiguous, and neither is publishable.
func resolveSecurityCandidate(
	c SecurityCandidate,
	aliases map[string]SecurityAlias,
	codes map[string]string,
	names map[string]CompanyNameMapping,
	ambiguous map[string]int,
) SecurityResolution {
	if c.Reject != "" {
		return SecurityResolution{Status: "not_a_security"}
	}

	if alias, ok := aliases[c.Norm]; ok {
		switch alias.Resolution {
		case "resolved":
			return SecurityResolution{
				StockCode: alias.StockCode, CompanyName: alias.DisplayName,
				Status: "resolved", MatchMethod: "curated_alias", Confidence: 1.0,
			}
		case "unlisted_fund":
			return SecurityResolution{Status: "unlisted_fund", MatchMethod: "curated_alias"}
		default:
			return SecurityResolution{Status: "not_a_security", MatchMethod: "curated_alias"}
		}
	}

	if c.Ticker != "" {
		if name, ok := codes[strings.ToUpper(c.Ticker)]; ok {
			return SecurityResolution{
				StockCode: strings.ToUpper(c.Ticker), CompanyName: name,
				Status: "resolved", MatchMethod: "ticker_in_text", Confidence: 1.0,
			}
		}
	}

	if mapping, ok := names[c.Norm]; ok {
		return SecurityResolution{
			StockCode: mapping.StockCode, CompanyName: mapping.CompanyName,
			Status: "resolved", MatchMethod: "name_exact", Confidence: 1.0,
		}
	}

	// A "Pty Ltd" / family trust / SMSF that matched nothing is not a listing we
	// failed to find — it is not a listed security at all. Classifying it as
	// unmatched buries the real curation work: 171 of a 607-row item-1 backlog
	// were private entities, and item 4 (directorships) is almost entirely them.
	// A curated alias still wins, because it is checked first.
	if c.Private {
		return SecurityResolution{Status: "not_a_security"}
	}

	// collapseCompanyNameMappings drops names that resolve to more than one
	// listing, so a same-name trap arrives here as a miss. Recording it as
	// 'ambiguous' rather than 'unmatched' keeps the curation backlog honest:
	// these need a human decision, not a new alias guess.
	if count, ok := ambiguous[c.Norm]; ok {
		return SecurityResolution{Status: "ambiguous", CandidateCount: count}
	}

	return SecurityResolution{Status: "unmatched"}
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

type securityResolveStats struct {
	Candidates  int
	Resolved    int
	Ambiguous   int
	Unmatched   int
	NotSecurity int
	Unlisted    int
	ByMethod    map[string]int
}

// runRegisterSecurityResolve rebuilds the auto-derived rows in one transaction,
// preserving analyst-only curation — the same posture as runMatch.
func runRegisterSecurityResolve(ctx context.Context, pool *pgxpool.Pool) (securityResolveStats, error) {
	stats := securityResolveStats{ByMethod: map[string]int{}}

	aliases, err := loadRegisterSecurityAliases(ctx, pool)
	if err != nil {
		return stats, fmt.Errorf("load aliases: %w", err)
	}
	codes, err := loadStockCodes(ctx, pool)
	if err != nil {
		return stats, fmt.Errorf("load stock codes: %w", err)
	}
	names, err := loadCompanyNameMappings(ctx, pool)
	if err != nil {
		return stats, fmt.Errorf("load company names: %w", err)
	}
	ambiguous, err := loadAmbiguousCompanyNames(ctx, pool)
	if err != nil {
		return stats, fmt.Errorf("load ambiguous names: %w", err)
	}

	type declaredRow struct {
		ID    string
		Text  string
		Lines []string
	}
	rows, err := pool.Query(ctx, `
		SELECT id::text, declared_text, declared_lines
		FROM register_declared_items
		WHERE item_no IN (1, 4) AND NOT is_nil`)
	if err != nil {
		return stats, err
	}
	var items []declaredRow
	for rows.Next() {
		var r declaredRow
		if err := rows.Scan(&r.ID, &r.Text, &r.Lines); err != nil {
			rows.Close()
			return stats, err
		}
		items = append(items, r)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return stats, err
	}

	tx, err := pool.Begin(ctx)
	if err != nil {
		return stats, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Rebuild auto rows; never touch analyst curation.
	if _, err := tx.Exec(ctx, `
		DELETE FROM register_item_securities
		WHERE match_method IS DISTINCT FROM 'analyst_fuzzy'`); err != nil {
		return stats, err
	}

	batch := &pgx.Batch{}
	queued := 0
	for _, item := range items {
		for _, c := range splitSecurityBlob(item.Lines, item.Text) {
			res := resolveSecurityCandidate(c, aliases, codes, names, ambiguous)
			stats.Candidates++
			switch res.Status {
			case "resolved":
				stats.Resolved++
				stats.ByMethod[res.MatchMethod]++
			case "ambiguous":
				stats.Ambiguous++
			case "unmatched":
				stats.Unmatched++
			case "unlisted_fund":
				stats.Unlisted++
			default:
				stats.NotSecurity++
			}

			var method any
			if res.MatchMethod != "" {
				method = res.MatchMethod
			}
			var code any
			if res.StockCode != "" {
				code = res.StockCode
			}
			batch.Queue(`
				INSERT INTO register_item_securities
					(item_id, candidate_ordinal, candidate_raw, candidate_norm,
					 stock_code, company_name, resolution_status, match_method,
					 confidence, candidate_count)
				VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
				ON CONFLICT (item_id, candidate_ordinal) DO UPDATE SET
					candidate_raw     = EXCLUDED.candidate_raw,
					candidate_norm    = EXCLUDED.candidate_norm,
					stock_code        = EXCLUDED.stock_code,
					company_name      = EXCLUDED.company_name,
					resolution_status = EXCLUDED.resolution_status,
					match_method      = EXCLUDED.match_method,
					confidence        = EXCLUDED.confidence,
					candidate_count   = EXCLUDED.candidate_count,
					resolved_at       = now()`,
				item.ID, c.Ordinal, c.Raw, c.Norm, code, res.CompanyName,
				res.Status, method, res.Confidence, res.CandidateCount)
			queued++
		}
	}

	if queued > 0 {
		br := tx.SendBatch(ctx, batch)
		for range queued {
			if _, err := br.Exec(); err != nil {
				_ = br.Close()
				return stats, fmt.Errorf("insert security candidate: %w", err)
			}
		}
		if err := br.Close(); err != nil {
			return stats, err
		}
	}

	return stats, tx.Commit(ctx)
}
