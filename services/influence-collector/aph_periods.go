package main

// Folds the register event stream into point-in-time holding intervals.
//
// WHY THIS IS NOT SQL: an add / delete / re-add sequence is TWO intervals, and
// min()/max() silently collapses it into one — turning "held 2022-2023, then
// again from 2025" into "held 2022 to now". The fold therefore walks the events
// in order.
//
// DATES ARE MOSTLY ABSENT ON BASE STATEMENTS. Measured: 1,492 of 1,492
// alteration additions carry a date, but only 126 of 2,574 base declarations do
// — the base form's date lives in a signature block. So a base declaration means
// "held as at this statement, exact start unknown", recorded as declared_from
// NULL with declared_from_known = FALSE. Inventing a date (the parliament's
// opening, say) would fabricate the start of a named person's holding.

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// holdingEvent is one declaration or alteration touching one holding.
type holdingEvent struct {
	PoliticianID  string
	ItemNo        int
	Holder        string
	HoldingKey    string
	StockCode     string
	SalCode       string
	DeclaredText  string
	SecondaryText string
	EntityKind    string
	ChangeType    string
	LodgedDate    *time.Time
	Parliament    int
	StatementID   string
	SourceURL     string
}

// holdingInterval is one continuous period a holding was declared for.
type holdingInterval struct {
	From             *time.Time
	FromKnown        bool
	To               *time.Time
	FirstStatementID string
	LastStatementID  string
	FirstParliament  int
	DeclaredText     string
	SecondaryText    string
	StockCode        string
	SalCode          string
	EntityKind       string
}

// selectHoldingEvents builds the event stream.
//
// The grain differs by item, because the thing being held differs:
//
//	items 1 & 4  one event per resolved SECURITY (or per unresolved candidate) —
//	             a single cell can list a dozen funds
//	item 3       one event per resolved suburb (or per locality)
//	everything   one event per declared row
//
// Candidates are excluded on entity_kind='not_an_entity' — prose, nil markers
// and gift-log lines — NOT on resolution_status='not_a_security'.
//
// The two used to be the same test, and it dropped every private company,
// family trust and SMSF a member declared under items 1 and 4: 1,140 candidate
// rows that never reached a read path, in the ONE item (4, directorships) that
// is almost entirely private entities. A trust is a real declared interest, and
// often a more interesting one than a CBA shareholding; 'not_a_security' means
// "not a LISTED security", which is not a reason to withhold it. entity_kind
// now separates "not listed" from "not a thing", so the filter can too.
const selectHoldingEventsQuery = `
	SELECT i.politician_id::text, i.item_no, i.holder,
	       COALESCE(NULLIF(sec.stock_code, ''), NULLIF(sec.candidate_norm, ''), upper(btrim(i.declared_text))) AS holding_key,
	       COALESCE(sec.stock_code, '') AS stock_code,
	       '' AS sal_code,
	       COALESCE(NULLIF(sec.candidate_raw, ''), i.declared_text) AS declared_text,
	       '' AS secondary_text,
	       sec.entity_kind,
	       i.change_type, s.lodged_date, COALESCE(s.parliament, 0), s.id::text, i.source_url
	FROM register_declared_items i
	JOIN register_statements s ON s.id = i.statement_id
	JOIN register_item_securities sec ON sec.item_id = i.id
	WHERE i.item_no IN (1, 4) AND NOT i.is_nil
	  AND i.politician_id IS NOT NULL
	  AND sec.entity_kind <> 'not_an_entity'

	UNION ALL

	SELECT i.politician_id::text, i.item_no, i.holder,
	       COALESCE(NULLIF(loc.sal_code, ''), NULLIF(loc.locality_norm, ''), upper(btrim(i.declared_text))) AS holding_key,
	       '' AS stock_code,
	       COALESCE(loc.sal_code, '') AS sal_code,
	       COALESCE(NULLIF(loc.locality_raw, ''), i.declared_text) AS declared_text,
	       COALESCE(loc.purpose_raw, '') AS secondary_text,
	       'listed' AS entity_kind,
	       i.change_type, s.lodged_date, COALESCE(s.parliament, 0), s.id::text, i.source_url
	FROM register_declared_items i
	JOIN register_statements s ON s.id = i.statement_id
	JOIN register_item_locations loc ON loc.item_id = i.id
	WHERE i.item_no = 3 AND NOT i.is_nil
	  AND i.politician_id IS NOT NULL

	UNION ALL

	SELECT i.politician_id::text, i.item_no, i.holder,
	       upper(btrim(i.declared_text)) AS holding_key,
	       '' AS stock_code, '' AS sal_code,
	       i.declared_text, i.secondary_text,
	       'listed' AS entity_kind,
	       i.change_type, s.lodged_date, COALESCE(s.parliament, 0), s.id::text, i.source_url
	FROM register_declared_items i
	JOIN register_statements s ON s.id = i.statement_id
	WHERE i.item_no NOT IN (1, 3, 4) AND NOT i.is_nil
	  AND i.politician_id IS NOT NULL
	  AND btrim(i.declared_text) <> ''`

func selectHoldingEvents(ctx context.Context, pool *pgxpool.Pool) ([]holdingEvent, error) {
	rows, err := pool.Query(ctx, selectHoldingEventsQuery)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []holdingEvent
	for rows.Next() {
		var e holdingEvent
		if err := rows.Scan(&e.PoliticianID, &e.ItemNo, &e.Holder, &e.HoldingKey,
			&e.StockCode, &e.SalCode, &e.DeclaredText, &e.SecondaryText,
			&e.EntityKind, &e.ChangeType, &e.LodgedDate, &e.Parliament, &e.StatementID, &e.SourceURL); err != nil {
			return nil, err
		}
		if strings.TrimSpace(e.HoldingKey) == "" {
			continue
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

// holdingGroupKey identifies one tracked holding.
type holdingGroupKey struct {
	PoliticianID string
	ItemNo       int
	Holder       string
	HoldingKey   string
}

// foldHoldingEvents walks each holding's events in order and emits intervals.
//
// Ordering is by parliament, then date with UNDATED FIRST: a base statement is
// the opening position for its parliament and its alterations follow, so an
// undated base declaration must be processed before the dated additions that
// amend it.
func foldHoldingEvents(events []holdingEvent) map[holdingGroupKey][]holdingInterval {
	grouped := map[holdingGroupKey][]holdingEvent{}
	for _, e := range events {
		key := holdingGroupKey{e.PoliticianID, e.ItemNo, e.Holder, e.HoldingKey}
		grouped[key] = append(grouped[key], e)
	}

	out := map[holdingGroupKey][]holdingInterval{}
	for key, group := range grouped {
		sort.SliceStable(group, func(a, b int) bool {
			if group[a].Parliament != group[b].Parliament {
				return group[a].Parliament < group[b].Parliament
			}
			ad, bd := group[a].LodgedDate, group[b].LodgedDate
			switch {
			case ad == nil && bd == nil:
				return false
			case ad == nil:
				return true // undated base statement opens the parliament
			case bd == nil:
				return false
			default:
				return ad.Before(*bd)
			}
		})

		var intervals []holdingInterval
		var open *holdingInterval

		for _, e := range group {
			switch e.ChangeType {
			case "deletion":
				if open != nil {
					open.To = e.LodgedDate
					open.LastStatementID = e.StatementID
					intervals = append(intervals, *open)
					open = nil
				}
				// A deletion with nothing open means the holding began before our
				// window. Recording a zero-length interval would imply it was
				// never held, so it is skipped and the gap stays visible.
			default: // "declared" | "addition"
				if open == nil {
					open = &holdingInterval{
						From:             e.LodgedDate,
						FromKnown:        e.LodgedDate != nil,
						FirstStatementID: e.StatementID,
						LastStatementID:  e.StatementID,
						FirstParliament:  e.Parliament,
						DeclaredText:     e.DeclaredText,
						SecondaryText:    e.SecondaryText,
						StockCode:        e.StockCode,
						SalCode:          e.SalCode,
						EntityKind:       e.EntityKind,
					}
					continue
				}
				// Re-declaring an already-open holding just confirms it.
				open.LastStatementID = e.StatementID
				if open.DeclaredText == "" {
					open.DeclaredText = e.DeclaredText
				}
				if open.StockCode == "" {
					open.StockCode = e.StockCode
				}
				if open.SalCode == "" {
					open.SalCode = e.SalCode
				}
				if open.EntityKind == "" {
					open.EntityKind = e.EntityKind
				}
			}
		}
		if open != nil {
			intervals = append(intervals, *open) // still declared
		}
		if len(intervals) > 0 {
			out[key] = intervals
		}
	}
	return out
}

type holdingFoldStats struct {
	Events      int
	Holdings    int
	Intervals   int
	Current     int
	UnknownFrom int
	Closed      int
}

// rebuildHoldingPeriods replaces register_holding_periods wholesale.
//
// A full rebuild rather than an upsert: the UNIQUE key includes declared_from,
// which is frequently NULL, and Postgres treats NULLs as distinct in a unique
// index — so an upsert would silently accumulate duplicates on every run.
func rebuildHoldingPeriods(ctx context.Context, pool *pgxpool.Pool) (holdingFoldStats, error) {
	var stats holdingFoldStats

	events, err := selectHoldingEvents(ctx, pool)
	if err != nil {
		return stats, fmt.Errorf("select events: %w", err)
	}
	stats.Events = len(events)

	sourceByStatement := map[string]string{}
	for _, e := range events {
		if _, ok := sourceByStatement[e.StatementID]; !ok {
			sourceByStatement[e.StatementID] = e.SourceURL
		}
	}

	folded := foldHoldingEvents(events)
	stats.Holdings = len(folded)

	tx, err := pool.Begin(ctx)
	if err != nil {
		return stats, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if _, err := tx.Exec(ctx, `TRUNCATE register_holding_periods`); err != nil {
		return stats, err
	}

	batch := &pgx.Batch{}
	queued := 0
	for key, intervals := range folded {
		for _, iv := range intervals {
			stats.Intervals++
			if iv.To == nil {
				stats.Current++
			} else {
				stats.Closed++
			}
			if !iv.FromKnown {
				stats.UnknownFrom++
			}

			var stock, sal any
			if iv.StockCode != "" {
				stock = iv.StockCode
			}
			if iv.SalCode != "" {
				sal = iv.SalCode
			}
			batch.Queue(`
				INSERT INTO register_holding_periods
					(politician_id, item_no, holder, holding_key, stock_code, sal_code,
					 declared_text, secondary_text, declared_from, declared_from_known,
					 declared_to, first_statement_id, last_statement_id,
					 first_parliament, source_url, entity_kind)
				VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
				        NULLIF($12,'')::uuid, NULLIF($13,'')::uuid, NULLIF($14,0), $15,
				        COALESCE(NULLIF($16,''), 'listed'))`,
				key.PoliticianID, key.ItemNo, key.Holder, key.HoldingKey, stock, sal,
				iv.DeclaredText, iv.SecondaryText, iv.From, iv.FromKnown, iv.To,
				iv.FirstStatementID, iv.LastStatementID, iv.FirstParliament,
				sourceByStatement[iv.FirstStatementID], iv.EntityKind)
			queued++
		}
	}

	if queued > 0 {
		br := tx.SendBatch(ctx, batch)
		for range queued {
			if _, err := br.Exec(); err != nil {
				_ = br.Close()
				return stats, fmt.Errorf("insert holding period: %w", err)
			}
		}
		if err := br.Close(); err != nil {
			return stats, err
		}
	}

	return stats, tx.Commit(ctx)
}

// refreshRegisterMaterializedViews runs the guarded refresh function.
func refreshRegisterMaterializedViews(ctx context.Context, pool *pgxpool.Pool) error {
	_, err := pool.Exec(ctx, `SELECT refresh_register_materialized_views()`)
	return err
}
