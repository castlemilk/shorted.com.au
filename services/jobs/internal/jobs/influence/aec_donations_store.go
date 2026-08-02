package influence

// Persistence and resolution for the AEC funding layer.
//
// SNAPSHOT-REPLACE, ONE TRANSACTION. The AEC regenerates its bulk exports
// continuously as amendments land, so an append would accumulate superseded
// versions of the same return and an in-place upsert would leave withdrawn rows
// behind forever. Truncate + load + resolve inside a single transaction means a
// reader either sees the whole previous snapshot or the whole new one.
//
// The curated alias table is NOT truncated: every row in it is a human decision.

import (
	"context"
	"fmt"
	"log"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// aecResolutionCounts is what an operator needs to see after a run: not just
// what resolved, but what was WITHHELD and why. A resolver that only reports its
// hits hides the day it stops matching anything.
type aecResolutionCounts struct {
	MPTotal           int
	MPResolvedAlias   int
	MPResolvedExact   int
	MPWithheldNoMatch int
	MPWithheldAmbig   int
	MPWithheldNoGiven int

	CandidateTotal             int
	CandidateResolvedAlias     int
	CandidateResolvedExact     int
	CandidateResolvedSenate    int
	CandidateWithheldNoEvent   int
	CandidateWithheldNoSeat    int
	CandidateWithheldNameParty int
	CandidateWithheldAmbig     int

	DonationsLinked   int
	DonationsUnlinked int
}

// storeAECDonations replaces the whole aec_* snapshot and resolves it.
func storeAECDonations(ctx context.Context, pool *pgxpool.Pool, corpus *AECDonationsCorpus) (*aecResolutionCounts, error) {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// aec_candidate_donations references aec_candidate_returns, so both are
	// named in one TRUNCATE rather than relying on CASCADE.
	if _, err := tx.Exec(ctx, `
		TRUNCATE aec_party_returns, aec_receipts, aec_donations_made,
		         aec_mp_returns, aec_candidate_donations, aec_candidate_returns`); err != nil {
		return nil, fmt.Errorf("truncate snapshot: %w", err)
	}

	if err := loadAECPartyReturns(ctx, tx, corpus); err != nil {
		return nil, err
	}
	if err := loadAECReceipts(ctx, tx, corpus); err != nil {
		return nil, err
	}
	if err := loadAECDonationsMade(ctx, tx, corpus); err != nil {
		return nil, err
	}
	if err := loadAECMPReturns(ctx, tx, corpus); err != nil {
		return nil, err
	}
	if err := loadAECCandidateReturns(ctx, tx, corpus); err != nil {
		return nil, err
	}
	if err := loadAECCandidateDonations(ctx, tx, corpus); err != nil {
		return nil, err
	}

	counts, err := resolveAECDonations(ctx, tx)
	if err != nil {
		return nil, err
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit: %w", err)
	}
	return counts, nil
}

// insertAECRows writes rows with multi-row INSERTs in parameter-bounded chunks.
//
// NOT pgx CopyFrom, deliberately. COPY is the faster tool and was the first
// implementation, but it fails on a Docker-for-Mac volume the moment the target
// carries a UUID-primary-key index: Postgres raises "unexpected data beyond EOF
// in block N" while bulk-extending the INDEX relation (reproduced against a
// bare probe table — no indexes copies fine, a uuid PK plus one unique index
// fails at ~8MB every time, at a different block each run). Every developer
// running the dev stack would hit it. A batched INSERT costs a few seconds
// across the ~209k-row corpus, takes the ordinary buffered-extension path, and
// behaves identically on Supabase, so the whole pipeline has ONE load path
// rather than a fast one and a silent fallback.
//
// Chunking keeps each statement under Postgres's 65,535 bound on bind
// parameters, which a 124k-row single statement would blow through instantly.
func insertAECRows(
	ctx context.Context,
	tx pgx.Tx,
	table string,
	columns []string,
	rowCount int,
	rowFn func(i int) []any,
) error {
	if rowCount == 0 {
		return nil
	}
	perRow := len(columns)
	chunk := 60000 / perRow
	if chunk < 1 {
		chunk = 1
	}

	prefix := "INSERT INTO " + table + " (" + strings.Join(columns, ", ") + ") VALUES "
	for start := 0; start < rowCount; start += chunk {
		end := start + chunk
		if end > rowCount {
			end = rowCount
		}
		var sb strings.Builder
		sb.WriteString(prefix)
		args := make([]any, 0, (end-start)*perRow)
		for i := start; i < end; i++ {
			if i > start {
				sb.WriteByte(',')
			}
			sb.WriteByte('(')
			for c := 0; c < perRow; c++ {
				if c > 0 {
					sb.WriteByte(',')
				}
				sb.WriteByte('$')
				sb.WriteString(strconv.Itoa(len(args) + c + 1))
			}
			sb.WriteByte(')')
			args = append(args, rowFn(i)...)
		}
		if _, err := tx.Exec(ctx, sb.String(), args...); err != nil {
			return fmt.Errorf("insert into %s (rows %d-%d): %w", table, start, end, err)
		}
	}
	return nil
}

func loadAECPartyReturns(ctx context.Context, tx pgx.Tx, c *AECDonationsCorpus) error {
	return insertAECRows(ctx, tx, "aec_party_returns",
		[]string{
			"financial_year", "financial_year_end", "party_name", "party_name_norm",
			"party_group", "party_group_key", "total_receipts_cents", "total_payments_cents",
			"total_debts_cents", "total_discretionary_cents", "occurrence",
			"source_url", "source_licence", "snapshot_at",
		},
		len(c.PartyReturns), func(i int) []any {
			r := c.PartyReturns[i]
			return []any{
				r.FinancialYear, r.FinancialYearEnd, r.PartyName, r.PartyNameNorm,
				r.PartyGroup, r.PartyGroupKey, r.ReceiptsCents, r.PaymentsCents,
				r.DebtsCents, r.DiscretionaryCents, r.Occurrence,
				c.AnnualSourceURL, aecLicence, c.SnapshotAt,
			}
		})
}

func loadAECReceipts(ctx context.Context, tx pgx.Tx, c *AECDonationsCorpus) error {
	return insertAECRows(ctx, tx, "aec_receipts",
		[]string{
			"financial_year", "financial_year_end", "return_type",
			"recipient_name", "recipient_name_norm", "received_from", "received_from_norm",
			"receipt_type", "amount_cents", "occurrence",
			"source_url", "source_licence", "snapshot_at",
		},
		len(c.Receipts), func(i int) []any {
			r := c.Receipts[i]
			return []any{
				r.FinancialYear, r.FinancialYearEnd, r.ReturnType,
				r.RecipientName, r.RecipientNameNorm, r.ReceivedFrom, r.ReceivedFromNorm,
				r.ReceiptType, r.AmountCents, r.Occurrence,
				c.AnnualSourceURL, aecLicence, c.SnapshotAt,
			}
		})
}

func loadAECDonationsMade(ctx context.Context, tx pgx.Tx, c *AECDonationsCorpus) error {
	return insertAECRows(ctx, tx, "aec_donations_made",
		[]string{
			"financial_year", "financial_year_end", "donor_name", "donor_name_norm",
			"made_to", "made_to_norm", "donation_date", "amount_cents", "occurrence",
			"source_url", "source_licence", "snapshot_at",
		},
		len(c.DonationsMade), func(i int) []any {
			r := c.DonationsMade[i]
			var date any
			if r.DonationDate != nil {
				date = *r.DonationDate
			}
			return []any{
				r.FinancialYear, r.FinancialYearEnd, r.DonorName, r.DonorNameNorm,
				r.MadeTo, r.MadeToNorm, date, r.AmountCents, r.Occurrence,
				c.AnnualSourceURL, aecLicence, c.SnapshotAt,
			}
		})
}

func loadAECMPReturns(ctx context.Context, tx pgx.Tx, c *AECDonationsCorpus) error {
	return insertAECRows(ctx, tx, "aec_mp_returns",
		[]string{
			"financial_year", "financial_year_end", "return_type", "chamber",
			"member_name", "member_name_norm", "surname", "given_names",
			"total_donations_cents", "donor_count",
			"source_url", "source_licence", "snapshot_at",
		},
		len(c.MPReturns), func(i int) []any {
			r := c.MPReturns[i]
			return []any{
				r.FinancialYear, r.FinancialYearEnd, r.ReturnType, r.Chamber,
				r.MemberName, r.MemberNameNorm, r.Surname, r.GivenNames,
				r.TotalCents, r.DonorCount,
				c.AnnualSourceURL, aecLicence, c.SnapshotAt,
			}
		})
}

func loadAECCandidateReturns(ctx context.Context, tx pgx.Tx, c *AECDonationsCorpus) error {
	return insertAECRows(ctx, tx, "aec_candidate_returns",
		[]string{
			"event", "event_year", "event_parliament", "return_type",
			"candidate_name", "surname", "given_names", "party_id", "party_name",
			"electorate_name", "electorate_state", "nil_return", "amendment_no",
			"total_gift_cents", "donor_count", "expenditure_cents", "discretionary_cents",
			"source_url", "source_licence", "snapshot_at",
		},
		len(c.CandidateReturns), func(i int) []any {
			r := c.CandidateReturns[i]
			var year, parliament any
			if r.EventYear != nil {
				year = *r.EventYear
			}
			if r.EventParliament != nil {
				parliament = *r.EventParliament
			}
			return []any{
				r.Event, year, parliament, r.ReturnType,
				r.CandidateName, r.Surname, r.GivenNames, r.PartyID, r.PartyName,
				r.ElectorateName, r.ElectorateState, r.NilReturn, r.AmendmentNo,
				r.TotalGiftCents, r.DonorCount, r.ExpenditureCents, r.DiscretionaryCents,
				c.ElectionsSourceURL, aecLicence, c.SnapshotAt,
			}
		})
}

func loadAECCandidateDonations(ctx context.Context, tx pgx.Tx, c *AECDonationsCorpus) error {
	return insertAECRows(ctx, tx, "aec_candidate_donations",
		[]string{
			"event", "event_year", "return_type", "candidate_name",
			"donor_name", "donor_name_norm", "donation_date", "amount_cents", "occurrence",
			"source_url", "source_licence", "snapshot_at",
		},
		len(c.CandidateDonations), func(i int) []any {
			r := c.CandidateDonations[i]
			var year, date any
			if r.EventYear != nil {
				year = *r.EventYear
			}
			if r.DonationDate != nil {
				date = *r.DonationDate
			}
			return []any{
				r.Event, year, r.ReturnType, r.CandidateName,
				r.DonorName, r.DonorNameNorm, date, r.AmountCents, r.Occurrence,
				c.ElectionsSourceURL, aecLicence, c.SnapshotAt,
			}
		})
}

// ---------------------------------------------------------------------------
// Resolution
//
// Order, per the plan: curated alias → exact rule → nothing. AMBIGUITY ALWAYS
// WITHHOLDS. A name search once matched "Anthony Smith" to Dean Smith, and the
// cost of a wrong join here is attributing someone else's money to a named
// living person.
//
// Every rule is set-based with `HAVING count(DISTINCT ...) = 1`, so "exactly
// one" is enforced by the query rather than by a loop that might take the first
// row it saw.
// ---------------------------------------------------------------------------

func resolveAECDonations(ctx context.Context, tx pgx.Tx) (*aecResolutionCounts, error) {
	counts := &aecResolutionCounts{}

	if err := tx.QueryRow(ctx, `SELECT count(*) FROM aec_mp_returns`).Scan(&counts.MPTotal); err != nil {
		return nil, fmt.Errorf("count mp returns: %w", err)
	}
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM aec_candidate_returns`).Scan(&counts.CandidateTotal); err != nil {
		return nil, fmt.Errorf("count candidate returns: %w", err)
	}

	// --- 1. Curated aliases, for both member layers. ------------------------
	//
	// The two layers are keyed in DIFFERENT formats — an MP return by its
	// normalised member name, a candidate return by 'SURNAME|GIVEN NAMES' — and
	// each pass names the layer it reads. Before target_layer existed, a curator
	// filing a key in the wrong format wrote a row that could never match and
	// never said so; now the table's CHECKs reject it at entry and these filters
	// make the intended layer explicit at read.
	tag, err := tx.Exec(ctx, `
		UPDATE aec_mp_returns r
		SET politician_id = a.politician_id, resolution_method = 'curated_alias'
		FROM aec_entity_aliases a
		WHERE a.target_kind = 'politician'
		  AND a.target_layer = 'entity_name'
		  AND a.alias_norm = r.member_name_norm
		  AND r.politician_id IS NULL`)
	if err != nil {
		return nil, fmt.Errorf("resolve mp returns by alias: %w", err)
	}
	counts.MPResolvedAlias = int(tag.RowsAffected())

	tag, err = tx.Exec(ctx, `
		UPDATE aec_candidate_returns c
		SET politician_id = a.politician_id, resolution_method = 'curated_alias'
		FROM aec_entity_aliases a
		WHERE a.target_kind = 'politician'
		  AND a.target_layer = 'candidate_name'
		  AND a.alias_norm = upper(c.surname) || '|' || upper(c.given_names)
		  AND c.politician_id IS NULL`)
	if err != nil {
		return nil, fmt.Errorf("resolve candidate returns by alias: %w", err)
	}
	counts.CandidateResolvedAlias = int(tag.RowsAffected())

	// --- 2. MP returns: honorific-stripped surname + given name. ------------
	// The first given name must match exactly. A return whose name reduces to a
	// bare surname has no given name to match on and stays NULL — that is the
	// "Anthony Smith"/Dean Smith failure mode made structurally impossible.
	tag, err = tx.Exec(ctx, `
		UPDATE aec_mp_returns r
		SET politician_id = m.politician_id, resolution_method = 'surname_given_exact'
		FROM (
			SELECT r.id, (array_agg(p.id))[1] AS politician_id
			FROM aec_mp_returns r
			JOIN politicians p
			  ON upper(p.surname) = upper(r.surname)
			 AND upper(split_part(p.given_names, ' ', 1)) = upper(split_part(r.given_names, ' ', 1))
			WHERE r.politician_id IS NULL
			  AND r.surname <> '' AND r.given_names <> ''
			  AND p.merged_into_id IS NULL
			  AND NOT EXISTS (
				  SELECT 1 FROM aec_entity_aliases i
				  WHERE i.alias_norm = r.member_name_norm
				    AND i.target_layer = 'entity_name'
				    AND i.target_kind = 'ignore')
			GROUP BY r.id
			HAVING count(DISTINCT p.id) = 1
		) m
		WHERE r.id = m.id AND r.politician_id IS NULL`)
	if err != nil {
		return nil, fmt.Errorf("resolve mp returns by name: %w", err)
	}
	counts.MPResolvedExact = int(tag.RowsAffected())

	// --- 3. Candidate returns: division + surname + GIVEN NAME within the
	// parliament the event elected, and never against a contradicting party.
	//
	// A division has one member per parliament, so the division+surname join
	// resolves the candidates who WON and withholds everyone else. That much was
	// the intended semantic. What it MISSED is that a LOSING candidate who shares
	// the winner's surname also satisfies it: 'RISHWORTH, James Philip' (Liberal,
	// Kingston 2025) resolved to Amanda Rishworth (ALP), and 'LE, Nguyen-Tu'
	// (ALP, Fowler 2025) resolved to Dai Le (IND). Both are the cardinal sin —
	// another person's declared money attributed to a named living person — and
	// both were live in the corpus.
	//
	// So the rule now demands two more agreements, each of which independently
	// rejects both of those rows:
	//
	//   * GIVEN NAMES must agree by exact token (aec_given_names_agree). No
	//     prefix, nickname or distance rule: 'Tony' does not match 'Anthony
	//     John', and that return withholds rather than being matched by a rule
	//     loose enough to also match a namesake. The curated alias table is where
	//     a diminutive is resolved, because that is a human decision on the
	//     record.
	//   * The candidate's party must not CONTRADICT the party of the term
	//     (aec_party_contradicts). Branch names and federal party names are never
	//     comparable as strings, so this compares FAMILIES and only ever
	//     withholds — it never makes a match. An unclassifiable label contradicts
	//     nothing.
	//
	// Senate Group returns carry a STATE in electorate_name and match no
	// division, so they still withhold without a special case.
	tag, err = tx.Exec(ctx, `
		UPDATE aec_candidate_returns c
		SET politician_id = m.politician_id, resolution_method = 'division_surname_given_exact'
		FROM (
			SELECT c.id, (array_agg(p.id))[1] AS politician_id
			FROM aec_candidate_returns c
			JOIN politician_terms t
			  ON t.parliament = c.event_parliament
			 AND t.division IS NOT NULL
			 AND upper(t.division) = upper(c.electorate_name)
			 AND NOT aec_party_contradicts(c.party_name, t.party)
			JOIN politicians p
			  ON p.id = t.politician_id
			 AND upper(p.surname) = upper(c.surname)
			 AND p.merged_into_id IS NULL
			 AND aec_given_names_agree(c.given_names, p.given_names)
			WHERE c.politician_id IS NULL
			  AND c.event_parliament IS NOT NULL
			  AND c.electorate_name <> '' AND c.surname <> ''
			  AND NOT EXISTS (
				  SELECT 1 FROM aec_entity_aliases i
				  WHERE i.alias_norm = upper(c.surname) || '|' || upper(c.given_names)
				    AND i.target_layer = 'candidate_name'
				    AND i.target_kind = 'ignore')
			GROUP BY c.id
			HAVING count(DISTINCT p.id) = 1
		) m
		WHERE c.id = m.id AND c.politician_id IS NULL`)
	if err != nil {
		return nil, fmt.Errorf("resolve candidate returns by division: %w", err)
	}
	counts.CandidateResolvedExact = int(tag.RowsAffected())

	// --- 3b. Party as a tiebreaker, and ONLY as a tiebreaker.
	//
	// Rule 3 already demands exactly one politician, so this pass can only ever
	// touch rows where a division held two same-surname members in one
	// parliament (a by-election succession). Party is matched EXACTLY, never by
	// prefix: the AEC records branch names ("Australian Labor Party (Victorian
	// Branch)") while politician_terms records the federal party, so a prefix
	// match would be a fuzzy match wearing a disguise, and inexactness here
	// costs a misattribution.
	//
	// It carries rule 3's GUARDS, not just its shape. This pass used to skip the
	// 'ignore' suppression that rule 3 honours, which made the curated table a
	// remedy that silently failed on exactly the rows it was written for — a
	// curator suppressing a wrong match would have watched 3b re-make it. Given
	// names are required here for the same reason: a tiebreaker that resolves
	// what the primary rule refused to is not a tiebreaker, it is a bypass.
	tag, err = tx.Exec(ctx, `
		UPDATE aec_candidate_returns c
		SET politician_id = m.politician_id, resolution_method = 'division_surname_given_exact'
		FROM (
			SELECT c.id, (array_agg(p.id))[1] AS politician_id
			FROM aec_candidate_returns c
			JOIN politician_terms t
			  ON t.parliament = c.event_parliament
			 AND t.division IS NOT NULL
			 AND upper(t.division) = upper(c.electorate_name)
			 AND t.party IS NOT NULL
			 AND upper(t.party) = upper(c.party_name)
			JOIN politicians p
			  ON p.id = t.politician_id
			 AND upper(p.surname) = upper(c.surname)
			 AND p.merged_into_id IS NULL
			 AND aec_given_names_agree(c.given_names, p.given_names)
			WHERE c.politician_id IS NULL
			  AND c.event_parliament IS NOT NULL
			  AND c.electorate_name <> '' AND c.surname <> '' AND c.party_name <> ''
			  AND NOT EXISTS (
				  SELECT 1 FROM aec_entity_aliases i
				  WHERE i.alias_norm = upper(c.surname) || '|' || upper(c.given_names)
				    AND i.target_layer = 'candidate_name'
				    AND i.target_kind = 'ignore')
			GROUP BY c.id
			HAVING count(DISTINCT p.id) = 1
		) m
		WHERE c.id = m.id AND c.politician_id IS NULL`)
	if err != nil {
		return nil, fmt.Errorf("resolve candidate returns by division and party: %w", err)
	}
	counts.CandidateResolvedExact += int(tag.RowsAffected())

	// --- 3c. SENATE candidate returns: state + surname + given name.
	//
	// A Senate candidate contests a STATE, not a division, so rules 3 and 3b
	// could never touch one: `electorate_name` holds "Victoria", which matches
	// no division, and 4,339 candidate returns withheld structurally rather than
	// on any evidence about the person. That was correct while the politicians
	// table was House-only and there was nothing to join to. register-senators
	// creates the other side of the join, so the rule can now exist.
	//
	// IT IS THE SAME RULE AS 3, WITH ONE COLUMN SWAPPED. Every guard is carried
	// over unchanged, because each of them stops a failure that does not care
	// which chamber it happens in:
	//
	//   * given names must agree by exact token — the "Tony" / "Anthony John"
	//     withhold, which is what stops a losing namesake from collecting a
	//     sitting senator's money;
	//   * the party must not CONTRADICT the term's party;
	//   * an 'ignore' alias suppresses the row, so a curator's correction cannot
	//     be silently re-made;
	//   * HAVING count(DISTINCT p.id) = 1 — and this matters MORE here than in
	//     rule 3. A division has ONE member per parliament; a state has TWELVE
	//     senators. The state key is therefore ~12x coarser, and it is only the
	//     surname + given-name agreement that narrows it back to one person. Any
	//     state where two senators share a surname and an agreeing given name
	//     withholds both, which is the intended outcome.
	//
	// The state is matched on the CODE column (electorate_state), with
	// electorate_name required to be the matching full state name. Requiring
	// both is what keeps a division that happens to share a state's name — none
	// exists today, and a redistribution is not this rule's business — out.
	//
	// SENATE GROUP RETURNS STAY UNRESOLVABLE, FOREVER. return_type is filtered
	// to 'Candidate'. A Senate Group return is lodged by a party's ticket, not
	// by a person; attributing it to the lead candidate would put a whole
	// ticket's money under one named individual's profile. That is a category
	// error, not a coverage gap, and the existing test asserting those 166 rows
	// never resolve is CORRECT and stays.
	tag, err = tx.Exec(ctx, `
		UPDATE aec_candidate_returns c
		SET politician_id = m.politician_id, resolution_method = 'state_surname_given_exact'
		FROM (
			SELECT c.id, (array_agg(p.id))[1] AS politician_id
			FROM aec_candidate_returns c
			JOIN politician_terms t
			  ON t.parliament = c.event_parliament
			 AND t.chamber = 'senate'
			 AND t.state_code IS NOT NULL
			 AND upper(t.state_code) = upper(c.electorate_state)
			 AND NOT aec_party_contradicts(c.party_name, t.party)
			JOIN politicians p
			  ON p.id = t.politician_id
			 AND upper(p.surname) = upper(c.surname)
			 AND p.merged_into_id IS NULL
			 AND aec_given_names_agree(c.given_names, p.given_names)
			WHERE c.politician_id IS NULL
			  AND c.return_type = 'Candidate'
			  AND c.event_parliament IS NOT NULL
			  AND c.electorate_state <> '' AND c.surname <> ''
			  AND upper(btrim(c.electorate_name)) = upper(aec_state_full_name(c.electorate_state))
			  AND NOT EXISTS (
				  SELECT 1 FROM aec_entity_aliases i
				  WHERE i.alias_norm = upper(c.surname) || '|' || upper(c.given_names)
				    AND i.target_layer = 'candidate_name'
				    AND i.target_kind = 'ignore')
			GROUP BY c.id
			HAVING count(DISTINCT p.id) = 1
		) m
		WHERE c.id = m.id AND c.politician_id IS NULL`)
	if err != nil {
		return nil, fmt.Errorf("resolve senate candidate returns by state: %w", err)
	}
	counts.CandidateResolvedSenate = int(tag.RowsAffected())

	// --- 4. Link itemised candidate donations to their summary return.
	// Same discipline: link only when exactly one return matches, so a donation
	// is never attached to the wrong one of two same-named candidates.
	tag, err = tx.Exec(ctx, `
		UPDATE aec_candidate_donations d
		SET candidate_return_id = m.return_id
		FROM (
			SELECT d.id, (array_agg(r.id))[1] AS return_id
			FROM aec_candidate_donations d
			JOIN aec_candidate_returns r
			  ON r.event = d.event
			 AND r.return_type = d.return_type
			 AND r.candidate_name = d.candidate_name
			GROUP BY d.id
			HAVING count(DISTINCT r.id) = 1
		) m
		WHERE d.id = m.id`)
	if err != nil {
		return nil, fmt.Errorf("link candidate donations: %w", err)
	}
	counts.DonationsLinked = int(tag.RowsAffected())

	if err := tx.QueryRow(ctx, `
		SELECT count(*) FROM aec_candidate_donations WHERE candidate_return_id IS NULL`).
		Scan(&counts.DonationsUnlinked); err != nil {
		return nil, fmt.Errorf("count unlinked donations: %w", err)
	}

	if err := countAECWithheld(ctx, tx, counts); err != nil {
		return nil, err
	}
	return counts, nil
}

// countAECWithheld attributes every unresolved row to a REASON. A bare
// "18 withheld" tells an operator nothing about whether the resolver broke or
// the corpus simply contains people we hold no term for.
func countAECWithheld(ctx context.Context, tx pgx.Tx, counts *aecResolutionCounts) error {
	err := tx.QueryRow(ctx, `
		SELECT
			count(*) FILTER (WHERE given_names = '' OR surname = ''),
			count(*) FILTER (WHERE given_names <> '' AND surname <> '' AND candidates = 0),
			count(*) FILTER (WHERE given_names <> '' AND surname <> '' AND candidates > 1)
		FROM (
			SELECT r.given_names, r.surname,
			       (SELECT count(DISTINCT p.id) FROM politicians p
			        WHERE upper(p.surname) = upper(r.surname)
			          AND upper(split_part(p.given_names, ' ', 1)) = upper(split_part(r.given_names, ' ', 1))
			          AND p.merged_into_id IS NULL) AS candidates
			FROM aec_mp_returns r
			WHERE r.politician_id IS NULL
		) x`).Scan(&counts.MPWithheldNoGiven, &counts.MPWithheldNoMatch, &counts.MPWithheldAmbig)
	if err != nil {
		return fmt.Errorf("count withheld mp returns: %w", err)
	}

	// The candidate reasons are counted in the SAME ORDER the rule applies them,
	// so "no term for that seat and surname" and "the seat's member is a
	// different person" are never conflated. The second is the interesting
	// number: it is the losing-namesake population the given-name and party
	// guards now withhold, and it must be visible or the guards look like a
	// resolver that quietly stopped matching.
	err = tx.QueryRow(ctx, `
		SELECT
			count(*) FILTER (WHERE event_parliament IS NULL),
			count(*) FILTER (WHERE event_parliament IS NOT NULL AND surname_holders = 0),
			count(*) FILTER (WHERE event_parliament IS NOT NULL AND surname_holders > 0 AND agreeing = 0),
			count(*) FILTER (WHERE event_parliament IS NOT NULL AND agreeing > 1)
		FROM (
			SELECT c.event_parliament,
			       (SELECT count(DISTINCT p.id)
			        FROM politician_terms t
			        JOIN politicians p ON p.id = t.politician_id AND p.merged_into_id IS NULL
			        WHERE t.parliament = c.event_parliament
			          AND t.division IS NOT NULL
			          AND upper(t.division) = upper(c.electorate_name)
			          AND upper(p.surname) = upper(c.surname)) AS surname_holders,
			       (SELECT count(DISTINCT p.id)
			        FROM politician_terms t
			        JOIN politicians p ON p.id = t.politician_id AND p.merged_into_id IS NULL
			        WHERE t.parliament = c.event_parliament
			          AND t.division IS NOT NULL
			          AND upper(t.division) = upper(c.electorate_name)
			          AND upper(p.surname) = upper(c.surname)
			          AND aec_given_names_agree(c.given_names, p.given_names)
			          AND NOT aec_party_contradicts(c.party_name, t.party)) AS agreeing
			FROM aec_candidate_returns c
			WHERE c.politician_id IS NULL
		) x`).Scan(&counts.CandidateWithheldNoEvent, &counts.CandidateWithheldNoSeat,
		&counts.CandidateWithheldNameParty, &counts.CandidateWithheldAmbig)
	if err != nil {
		return fmt.Errorf("count withheld candidate returns: %w", err)
	}
	return nil
}

// refreshAECDonationsViews rebuilds the party funding rollup. It runs OUTSIDE
// the load transaction because REFRESH MATERIALIZED VIEW CONCURRENTLY cannot
// run inside a transaction block.
//
// IT FAILS LOUDLY. The refresh function used to catch every error into a
// WARNING, so this call could not fail: the mode logged a successful run while
// mv_aec_party_funding still described the snapshot the load had just
// TRUNCATEd, and the explorer captioned those stale figures with the new
// snapshot's timestamp. The function now returns a boolean and lets a failed
// fallback propagate; a failure is recorded in aec_refresh_log (best effort —
// the failure itself is what the caller acts on) and returned.
func refreshAECDonationsViews(ctx context.Context, pool *pgxpool.Pool) error {
	var refreshed bool
	if err := pool.QueryRow(ctx, `SELECT refresh_aec_donations_materialized_views()`).Scan(&refreshed); err != nil {
		recordAECRefreshFailure(ctx, pool, err.Error())
		return fmt.Errorf("refresh aec materialized views: %w", err)
	}
	if !refreshed {
		recordAECRefreshFailure(ctx, pool, "refresh function reported failure")
		return fmt.Errorf("refresh aec materialized views: the refresh function reported failure; mv_aec_party_funding still describes the previous snapshot")
	}
	return nil
}

// recordAECRefreshFailure leaves the failed attempt in the log beside the
// successes. Without it the log would only ever show refreshes that worked,
// which is the same lie in a different table.
func recordAECRefreshFailure(ctx context.Context, pool *pgxpool.Pool, detail string) {
	if _, err := pool.Exec(ctx, `
		INSERT INTO aec_refresh_log (succeeded, method, detail)
		VALUES (FALSE, 'failed', $1)`, detail); err != nil {
		log.Printf("[aec-donations] could not record the refresh failure: %v", err)
	}
}

// aecCompanyMatchCounts reports how many donors and payers resolve to a listed
// company. Exact normalised name only, ambiguous names excluded — the counts
// are the honest denominator for anything the explorer renders as a company.
// Every count here is a DISTINCT-NORMALISED-NAME count beside a distinct
// stock-code count, because the two differ once a curated alias points two
// spellings of one entity at the same company — and a reconciliation against a
// recon inventory is meaningless if the denominator is ambiguous.
type aecCompanyMatchCounts struct {
	DistinctCompanyNames int
	DonationDonors       int
	DonationCodes        int
	ReceiptPayers        int
	ReceiptCodes         int
	DonationRows         int
	ReceiptRows          int
	DonationCents        int64
	ReceiptCents         int64
}

func loadAECCompanyMatchCounts(ctx context.Context, pool *pgxpool.Pool) (*aecCompanyMatchCounts, error) {
	out := &aecCompanyMatchCounts{}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM v_aec_company_name_matches`).
		Scan(&out.DistinctCompanyNames); err != nil {
		return nil, fmt.Errorf("count company matches: %w", err)
	}
	if err := pool.QueryRow(ctx, `
		SELECT count(DISTINCT d.donor_name_norm), count(DISTINCT m.stock_code),
		       count(*), COALESCE(sum(d.amount_cents), 0)
		FROM aec_donations_made d
		JOIN v_aec_company_name_matches m ON m.name_norm = d.donor_name_norm`).
		Scan(&out.DonationDonors, &out.DonationCodes, &out.DonationRows, &out.DonationCents); err != nil {
		return nil, fmt.Errorf("count matched donors: %w", err)
	}
	if err := pool.QueryRow(ctx, `
		SELECT count(DISTINCT r.received_from_norm), count(DISTINCT m.stock_code),
		       count(*), COALESCE(sum(r.amount_cents), 0)
		FROM aec_receipts r
		JOIN v_aec_company_name_matches m ON m.name_norm = r.received_from_norm`).
		Scan(&out.ReceiptPayers, &out.ReceiptCodes, &out.ReceiptRows, &out.ReceiptCents); err != nil {
		return nil, fmt.Errorf("count matched payers: %w", err)
	}
	return out, nil
}

// ---------------------------------------------------------------------------
// Mode entry point
// ---------------------------------------------------------------------------

// runAECDonationsMode is `-mode aec-donations`. It is EXCLUDED from `-mode all`
// for the same reason the register modes are: -mode all runs on every prod
// deploy, and a three-archive download plus a full-table replace of the funding
// layer must be an operator's decision, not a deploy step's side effect.
//
// With -dry it parses everything and prints the counts, writing nothing.
func runAECDonationsMode(ctx context.Context, pool *pgxpool.Pool, dry bool) error {
	started := time.Now()
	corpus, err := ingestAECDonations(ctx)
	if err != nil {
		return fmt.Errorf("[aec-donations] ingest error: %w", err)
	}

	log.Printf("[aec-donations] parsed party_returns=%d receipts=%d donations_made=%d mp_returns=%d candidate_returns=%d candidate_donations=%d in %s",
		len(corpus.PartyReturns), len(corpus.Receipts), len(corpus.DonationsMade),
		len(corpus.MPReturns), len(corpus.CandidateReturns), len(corpus.CandidateDonations),
		time.Since(started).Round(time.Millisecond))
	logAECMemberCounts(corpus)

	if dry {
		log.Printf("[aec-donations] -dry: nothing written, no resolution run, no view refreshed")
		return nil
	}

	counts, err := storeAECDonations(ctx, pool, corpus)
	if err != nil {
		return fmt.Errorf("[aec-donations] store error: %w", err)
	}

	log.Printf("[aec-donations] mp returns: %d total, %d resolved (%d alias, %d surname+given), %d withheld (%d no matching politician, %d ambiguous, %d no given name)",
		counts.MPTotal,
		counts.MPResolvedAlias+counts.MPResolvedExact,
		counts.MPResolvedAlias, counts.MPResolvedExact,
		counts.MPTotal-counts.MPResolvedAlias-counts.MPResolvedExact,
		counts.MPWithheldNoMatch, counts.MPWithheldAmbig, counts.MPWithheldNoGiven)
	log.Printf("[aec-donations] candidate returns: %d total, %d resolved (%d alias, %d division+surname+given, %d state+surname+given [senate]), %d withheld (%d event not mapped to a parliament, %d no term for that seat and surname, %d the seat's member is a different person by given name or party, %d ambiguous)",
		counts.CandidateTotal,
		counts.CandidateResolvedAlias+counts.CandidateResolvedExact+counts.CandidateResolvedSenate,
		counts.CandidateResolvedAlias, counts.CandidateResolvedExact, counts.CandidateResolvedSenate,
		counts.CandidateTotal-counts.CandidateResolvedAlias-counts.CandidateResolvedExact-counts.CandidateResolvedSenate,
		counts.CandidateWithheldNoEvent, counts.CandidateWithheldNoSeat,
		counts.CandidateWithheldNameParty, counts.CandidateWithheldAmbig)
	log.Printf("[aec-donations] candidate donations: %d linked to a return, %d unlinked",
		counts.DonationsLinked, counts.DonationsUnlinked)

	if err := refreshAECDonationsViews(ctx, pool); err != nil {
		return fmt.Errorf("[aec-donations] %w", err)
	}

	matches, err := loadAECCompanyMatchCounts(ctx, pool)
	if err != nil {
		return fmt.Errorf("[aec-donations] %w", err)
	}
	// Whole-corpus figures (FY1998-99 onward), not a single year: a recon
	// inventory scoped to recent financial years will read lower, and the two are
	// only comparable when the window is stated.
	log.Printf("[aec-donations] listed-company matches over the WHOLE corpus (exact normalised name, ambiguous names excluded): %d donor names → %d ASX codes across %d donation rows ($%d); %d payer names → %d ASX codes across %d receipt rows ($%d); from %d matchable company names",
		matches.DonationDonors, matches.DonationCodes, matches.DonationRows, matches.DonationCents/100,
		matches.ReceiptPayers, matches.ReceiptCodes, matches.ReceiptRows, matches.ReceiptCents/100,
		matches.DistinctCompanyNames)
	log.Printf("[aec-donations] every figure above is RIGHT-CENSORED at the disclosure threshold in force for its year; %s", aecThresholdNote)
	log.Printf("[aec-donations] completed in %s", time.Since(started).Round(time.Millisecond))
	return nil
}

func logAECMemberCounts(corpus *AECDonationsCorpus) {
	names := make([]string, 0, len(corpus.MemberRowCounts))
	for name := range corpus.MemberRowCounts {
		names = append(names, name)
	}
	sortStrings(names)
	for _, name := range names {
		log.Printf("[aec-donations] source member %s: %d rows", name, corpus.MemberRowCounts[name])
	}
}
