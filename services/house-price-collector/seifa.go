package main

import (
	"context"
	"fmt"
	"log"
	"math"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	seifaDataflow = "ABS_SEIFA2021_SAL,1.0.0"

	// Product quality policy: do not publish a SAL index when more than 10% of
	// its usual residents lack an SA1 score. URPXSA1 is fetched solely for this
	// gate; it is not stored or exposed as a page metric.
	seifaMissingSA1ShareThreshold = 10.0
)

var seifaIndexTypes = []string{"IRSD", "IRSAD", "IER", "IEO"}

type seifaColumnSet struct {
	score       string
	decileAus   string
	decileState string
}

// seifaColumnsFor is the only index-code-to-column mapping. Callers pass ABS
// codes, never labels, and the returned identifiers come from this fixed list.
func seifaColumnsFor(indexType string) (seifaColumnSet, bool) {
	switch indexType {
	case "IRSD":
		return seifaColumnSet{"seifa_irsd_score", "seifa_irsd_decile_aus", "seifa_irsd_decile_state"}, true
	case "IRSAD":
		return seifaColumnSet{"seifa_irsad_score", "seifa_irsad_decile_aus", "seifa_irsad_decile_state"}, true
	case "IER":
		return seifaColumnSet{"seifa_ier_score", "seifa_ier_decile_aus", "seifa_ier_decile_state"}, true
	case "IEO":
		return seifaColumnSet{"seifa_ieo_score", "seifa_ieo_decile_aus", "seifa_ieo_decile_state"}, true
	default:
		return seifaColumnSet{}, false
	}
}

func seifaFetchKey(indexType string) string {
	return "." + indexType + ".SCORE+RWAD+RWSD+URPXSA1"
}

type seifaValues struct {
	salCode         string
	indexType       string
	score           *int
	decileAus       *int
	decileState     *int
	missingSA1Share *float64
	qualityGated    bool
}

func (v seifaValues) hasIndexValues() bool {
	return v.score != nil || v.decileAus != nil || v.decileState != nil
}

// parseSEIFARows folds the measure-per-row SDMX shape into one nullable update
// per SAL and index. Blank/non-numeric observations and unknown pinned codes are
// ignored. A high URPXSA1 share deliberately clears all three index values.
func parseSEIFARows(rows [][]string, expectedIndex string) []seifaValues {
	if len(rows) < 2 {
		return nil
	}
	if _, ok := seifaColumnsFor(expectedIndex); !ok {
		return nil
	}
	columns := absColIndex(rows[0])
	salCol, salOK := columns["SAL"]
	indexCol, indexOK := columns["SEIFAINDEXTYPE"]
	measureCol, measureOK := columns["SEIFA_MEASURE"]
	valueCol, valueOK := columns["OBS_VALUE"]
	if !salOK || !indexOK || !measureOK || !valueOK {
		return nil
	}

	bySAL := make(map[string]*seifaValues)
	order := make([]string, 0)
	get := func(salCode string) *seifaValues {
		if existing := bySAL[salCode]; existing != nil {
			return existing
		}
		v := &seifaValues{salCode: salCode, indexType: expectedIndex}
		bySAL[salCode] = v
		order = append(order, salCode)
		return v
	}

	for _, row := range rows[1:] {
		indexType := absCode(cell(row, indexCol))
		if indexType != expectedIndex {
			continue
		}
		measure := absCode(cell(row, measureCol))
		switch measure {
		case "SCORE", "RWAD", "RWSD", "URPXSA1":
		default:
			continue
		}
		salCode := absCode(cell(row, salCol))
		if salCode == "" {
			continue
		}
		value, err := strconv.ParseFloat(strings.TrimSpace(cell(row, valueCol)), 64)
		if err != nil || math.IsNaN(value) || math.IsInf(value, 0) {
			continue
		}

		v := get(salCode)
		switch measure {
		case "SCORE":
			if score, ok := seifaInteger(value); ok {
				v.score = &score
			}
		case "RWAD":
			if decile, ok := seifaDecile(value); ok {
				v.decileAus = &decile
			}
		case "RWSD":
			if decile, ok := seifaDecile(value); ok {
				v.decileState = &decile
			}
		case "URPXSA1":
			if value >= 0 && value <= 100 {
				share := value
				v.missingSA1Share = &share
			}
		}
	}

	out := make([]seifaValues, 0, len(order))
	for _, salCode := range order {
		v := bySAL[salCode]
		if v.missingSA1Share != nil && *v.missingSA1Share > seifaMissingSA1ShareThreshold {
			v.score, v.decileAus, v.decileState = nil, nil, nil
			v.qualityGated = true
		}
		if !v.qualityGated && !v.hasIndexValues() {
			continue
		}
		out = append(out, *v)
	}
	return out
}

func seifaInteger(value float64) (int, bool) {
	rounded := math.Round(value)
	if value != rounded || rounded < 0 || rounded > math.MaxInt32 {
		return 0, false
	}
	return int(rounded), true
}

func seifaDecile(value float64) (int, bool) {
	decile, ok := seifaInteger(value)
	return decile, ok && decile >= 1 && decile <= 10
}

type absCSVFetcher func(context.Context, string, string, string) ([][]string, error)

// fetchSEIFA pages the large flow by index type. It intentionally requests the
// three page-facing measures plus URPXSA1, which is used only as a quality gate.
func fetchSEIFA(ctx context.Context, fetch absCSVFetcher) ([]seifaValues, int, error) {
	var values []seifaValues
	rowsFetched := 0
	for _, indexType := range seifaIndexTypes {
		key := seifaFetchKey(indexType)
		rows, err := fetch(ctx, seifaDataflow, key, "2021")
		if err != nil {
			return nil, rowsFetched, fmt.Errorf("fetch %s: %w", indexType, err)
		}
		if len(rows) > 1 {
			rowsFetched += len(rows) - 1
		}
		values = append(values, parseSEIFARows(rows, indexType)...)
	}
	return values, rowsFetched, nil
}

type seifaRunStats struct {
	rowsFetched    int
	suburbsUpdated int
	suburbsSkipped int
}

// updateExistingSEIFA only updates the Census/boundary-owned suburb spine. It
// never inserts a suburb_demographics row when a SAL is missing.
func updateExistingSEIFA(ctx context.Context, pool *pgxpool.Pool, values []seifaValues) (int, int, error) {
	type outcome struct {
		seen    bool
		updated bool
	}
	outcomes := make(map[string]outcome)

	for _, indexType := range seifaIndexTypes {
		columns, _ := seifaColumnsFor(indexType)
		query := fmt.Sprintf(`
			UPDATE suburb_demographics
			SET %s = $1, %s = $2, %s = $3
			WHERE sal_code = $4`, columns.score, columns.decileAus, columns.decileState)

		batch := &pgx.Batch{}
		queued := make([]seifaValues, 0)
		for _, value := range values {
			if value.indexType != indexType {
				continue
			}
			state := outcomes[value.salCode]
			state.seen = true
			outcomes[value.salCode] = state
			if !value.qualityGated && !value.hasIndexValues() {
				continue
			}
			batch.Queue(query, value.score, value.decileAus, value.decileState, value.salCode)
			queued = append(queued, value)
		}
		if len(queued) == 0 {
			continue
		}

		results := pool.SendBatch(ctx, batch)
		for _, value := range queued {
			tag, err := results.Exec()
			if err != nil {
				_ = results.Close()
				return 0, 0, fmt.Errorf("update %s/%s: %w", value.salCode, value.indexType, err)
			}
			if tag.RowsAffected() > 0 && !value.qualityGated {
				state := outcomes[value.salCode]
				state.updated = true
				outcomes[value.salCode] = state
			}
		}
		if err := results.Close(); err != nil {
			return 0, 0, fmt.Errorf("close %s update batch: %w", indexType, err)
		}
	}

	updated, skipped := 0, 0
	for _, state := range outcomes {
		if state.updated {
			updated++
		} else if state.seen {
			skipped++
		}
	}
	return updated, skipped, nil
}

func runSEIFA(ctx context.Context, pool *pgxpool.Pool) error {
	values, rowsFetched, err := fetchSEIFA(ctx, fetchABSCSV)
	if err != nil {
		return err
	}
	updated, skipped, err := updateExistingSEIFA(ctx, pool, values)
	if err != nil {
		return err
	}
	stats := seifaRunStats{rowsFetched: rowsFetched, suburbsUpdated: updated, suburbsSkipped: skipped}
	log.Printf("[seifa] rows fetched=%d suburbs updated=%d suburbs skipped=%d",
		stats.rowsFetched, stats.suburbsUpdated, stats.suburbsSkipped)
	return nil
}
