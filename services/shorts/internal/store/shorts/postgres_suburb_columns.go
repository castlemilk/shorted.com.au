package shorts

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"errors"
	"fmt"
	"math"
	"sort"
	"strings"
	"time"
)

// ErrUnknownSuburbMetricKey is returned before any SQL is built. Caller input
// is never interpolated into a query; only expressions in suburbMetricRegistry
// can reach PostgreSQL.
var ErrUnknownSuburbMetricKey = errors.New("unknown suburb metric key")

type suburbMetricJoin uint8

const (
	suburbMetricJoinPrice suburbMetricJoin = 1 << iota
	suburbMetricJoinAmenities
	suburbMetricJoinConnectivity
	suburbMetricJoinCrime
	suburbMetricJoinRegister
)

type suburbMetricDefinition struct {
	key        string
	expression string
	joins      suburbMetricJoin
	categories []string
}

var partyCategoryLabels = []string{
	"Labor", "Liberal", "Liberal National", "Country Liberal", "Nationals",
	"Greens", "Independent", "One Nation", "Katter's", "Centre Alliance",
	"Jacqui Lambie Network", "United Australia", "Palmer United",
	"Nick Xenophon Team", "Liberal Democrats", "Shooters, Fishers and Farmers",
	"Australian Conservatives", "Animal Justice", "Derryn Hinch's Justice",
	"Family First", "Democratic Labour", "Glenn Lazarus Team",
	"Australian Motoring Enthusiast", "Australia's Voice", "Other",
}

// suburbMetricRegistry is the single authority for public metric key -> SQL
// expression mapping. Both column delivery and filtering resolve through it.
// Categorical expressions return the zero-based index into categories.
var suburbMetricRegistry = map[string]suburbMetricDefinition{
	"price":         metric("price", "r.value", suburbMetricJoinPrice),
	"population":    metric("population", "d.population", 0),
	"age":           metric("age", "d.median_age", 0),
	"income":        metric("income", "d.median_weekly_hhd_income", 0),
	"born_overseas": metric("born_overseas", "d.pct_born_overseas", 0),
	"religion": categoryMetric("religion", `CASE
		WHEN NULLIF(d.top_religion, '') IS NULL THEN NULL
		WHEN d.top_religion = 'No religion' THEN 0
		WHEN d.top_religion = 'Catholic' THEN 1
		WHEN d.top_religion = 'Anglican' THEN 2
		WHEN d.top_religion = 'Other Christian' THEN 3
		WHEN d.top_religion = 'Islam' THEN 4
		WHEN d.top_religion = 'Hinduism' THEN 5
		WHEN d.top_religion = 'Buddhism' THEN 6
		WHEN d.top_religion = 'Judaism' THEN 7
		ELSE 8 END`, 0, []string{
		"No religion", "Catholic", "Anglican", "Other Christian", "Islam",
		"Hinduism", "Buddhism", "Judaism", "Other",
	}),
	"language": categoryMetric("language", `CASE
		WHEN d.population IS NULL OR d.population <= 0 THEN NULL
		WHEN NULLIF(d.top_language, '') IS NULL OR COALESCE(d.pct_top_language, 0) < 5 THEN 13
		WHEN d.top_language = 'Mandarin' THEN 0
		WHEN d.top_language = 'Cantonese' THEN 1
		WHEN d.top_language = 'Italian' THEN 2
		WHEN d.top_language = 'Greek' THEN 3
		WHEN d.top_language = 'Vietnamese' THEN 4
		WHEN d.top_language = 'Arabic' THEN 5
		WHEN d.top_language = 'Punjabi' THEN 6
		WHEN d.top_language = 'Hindi' THEN 7
		WHEN d.top_language = 'Spanish' THEN 8
		WHEN d.top_language = 'German' THEN 9
		WHEN d.top_language = 'Filipino' THEN 10
		WHEN d.top_language = 'Tagalog' THEN 11
		ELSE 12 END`, 0, []string{
		"Mandarin", "Cantonese", "Italian", "Greek", "Vietnamese", "Arabic",
		"Punjabi", "Hindi", "Spanish", "German", "Filipino", "Tagalog", "Other", "English",
	}),
	"federal_party": categoryMetric("federal_party", partyCodeExpression("d.federal_party_ab"), 0, partyCategoryLabels),
	"federal_lean":  metric("federal_lean", "d.federal_tpp_alp", 0),
	"state_party":   categoryMetric("state_party", partyCodeExpression("d.state_party_ab"), 0, partyCategoryLabels),
	"politician_property": metric("politician_property", `CASE
		WHEN d.population IS NULL OR d.population <= 0 THEN NULL
		ELSE COALESCE(rp.declared_property_count, 0) END`, suburbMetricJoinRegister),
	"crime_break_ins":     metric("crime_break_ins", "cr.break_ins_rank", suburbMetricJoinCrime),
	"crime_violent":       metric("crime_violent", "cr.violent_rank", suburbMetricJoinCrime),
	"crime_motor_vehicle": metric("crime_motor_vehicle", "cr.motor_vehicle_rank", suburbMetricJoinCrime),
	"amenity_density":     metric("amenity_density", "a.amenity_density_score", suburbMetricJoinAmenities),
	"supermarkets":        metric("supermarkets", "a.supermarkets_total", suburbMetricJoinAmenities),
	"pubs":                metric("pubs", "a.pubs_bars", suburbMetricJoinAmenities),
	"grocery": categoryMetric("grocery", `CASE
		WHEN d.population IS NULL OR d.population <= 0 OR a.sal_code IS NULL THEN NULL
		WHEN COALESCE(a.supermarkets_total, 0) <= 0 THEN 4
		WHEN COALESCE(a.aldi_count, 0) > 0 THEN 0
		WHEN COALESCE(a.coles_count, 0) > 0 AND COALESCE(a.woolworths_count, 0) > 0 THEN 1
		WHEN COALESCE(a.iga_count, 0) > 0 THEN 2
		ELSE 3 END`, suburbMetricJoinAmenities, []string{
		"Aldi present", "Coles + Woolworths", "IGA / independent", "Single major", "No supermarket",
	}),
	"healthcare": metric("healthcare", "a.gp_count", suburbMetricJoinAmenities),
	"school_sector": categoryMetric("school_sector", `CASE
		WHEN a.sal_code IS NULL OR COALESCE(a.schools_gov, 0) + COALESCE(a.schools_catholic, 0) + COALESCE(a.schools_independent, 0) <= 0 THEN NULL
		WHEN COALESCE(a.schools_gov, 0) >= COALESCE(a.schools_catholic, 0) AND COALESCE(a.schools_gov, 0) >= COALESCE(a.schools_independent, 0) THEN 0
		WHEN COALESCE(a.schools_catholic, 0) >= COALESCE(a.schools_independent, 0) THEN 1
		ELSE 2 END`, suburbMetricJoinAmenities, []string{"Government", "Catholic", "Independent"}),
	"nearest_train":     metric("nearest_train", "a.nearest_train_km", suburbMetricJoinAmenities),
	"distance_to_coast": metric("distance_to_coast", "a.dist_to_coast_km", suburbMetricJoinAmenities),
	"nbn": categoryMetric("nbn", `CASE
		WHEN NULLIF(c.dominant_nbn_tech, '') IS NULL THEN NULL
		WHEN UPPER(c.dominant_nbn_tech) IN ('FTTP', 'HFC', 'FTTC', 'FTTB', 'FTTN', 'FIXED LINE') THEN 0
		WHEN UPPER(c.dominant_nbn_tech) IN ('FW', 'FIXED WIRELESS') THEN 1
		WHEN UPPER(c.dominant_nbn_tech) = 'SATELLITE' THEN 2
		ELSE NULL END`, suburbMetricJoinConnectivity, []string{"Fixed Line", "Fixed Wireless", "Satellite"}),

	"seifa_irsd_score":         metric("seifa_irsd_score", "d.seifa_irsd_score", 0),
	"seifa_irsd_decile_aus":    metric("seifa_irsd_decile_aus", "d.seifa_irsd_decile_aus", 0),
	"seifa_irsd_decile_state":  metric("seifa_irsd_decile_state", "d.seifa_irsd_decile_state", 0),
	"seifa_irsad_score":        metric("seifa_irsad_score", "d.seifa_irsad_score", 0),
	"seifa_irsad_decile_aus":   metric("seifa_irsad_decile_aus", "d.seifa_irsad_decile_aus", 0),
	"seifa_irsad_decile_state": metric("seifa_irsad_decile_state", "d.seifa_irsad_decile_state", 0),
	"seifa_ier_score":          metric("seifa_ier_score", "d.seifa_ier_score", 0),
	"seifa_ier_decile_aus":     metric("seifa_ier_decile_aus", "d.seifa_ier_decile_aus", 0),
	"seifa_ier_decile_state":   metric("seifa_ier_decile_state", "d.seifa_ier_decile_state", 0),
	"seifa_ieo_score":          metric("seifa_ieo_score", "d.seifa_ieo_score", 0),
	"seifa_ieo_decile_aus":     metric("seifa_ieo_decile_aus", "d.seifa_ieo_decile_aus", 0),
	"seifa_ieo_decile_state":   metric("seifa_ieo_decile_state", "d.seifa_ieo_decile_state", 0),

	"pct_low_personal_income":         metric("pct_low_personal_income", "d.pct_low_personal_income", 0),
	"pct_high_personal_income":        metric("pct_high_personal_income", "d.pct_high_personal_income", 0),
	"unemployment_rate":               metric("unemployment_rate", "d.unemployment_rate", 0),
	"labour_force_participation_rate": metric("labour_force_participation_rate", "d.labour_force_participation_rate", 0),
	"pct_bachelor_or_higher":          metric("pct_bachelor_or_higher", "d.pct_bachelor_or_higher", 0),
	"pct_separate_house":              metric("pct_separate_house", "d.pct_separate_house", 0),
	"pct_flat_apartment":              metric("pct_flat_apartment", "d.pct_flat_apartment", 0),
	"pct_couple_with_children":        metric("pct_couple_with_children", "d.pct_couple_with_children", 0),
	"pct_lone_person_household":       metric("pct_lone_person_household", "d.pct_lone_person_household", 0),

	"elevation_min_m":     metric("elevation_min_m", "d.elevation_min_m", 0),
	"elevation_median_m":  metric("elevation_median_m", "d.elevation_median_m", 0),
	"elevation_max_m":     metric("elevation_max_m", "d.elevation_max_m", 0),
	"land_share_below_1m": metric("land_share_below_1m", "d.land_share_below_1m", 0),
	"land_share_below_2m": metric("land_share_below_2m", "d.land_share_below_2m", 0),
	"land_share_below_5m": metric("land_share_below_5m", "d.land_share_below_5m", 0),
}

func metric(key, expression string, joins suburbMetricJoin) suburbMetricDefinition {
	return suburbMetricDefinition{key: key, expression: expression, joins: joins}
}

func categoryMetric(key, expression string, joins suburbMetricJoin, categories []string) suburbMetricDefinition {
	return suburbMetricDefinition{key: key, expression: expression, joins: joins, categories: categories}
}

func partyCodeExpression(column string) string {
	return fmt.Sprintf(`CASE
		WHEN NULLIF(%[1]s, '') IS NULL THEN NULL
		WHEN UPPER(%[1]s) = 'ALP' THEN 0
		WHEN UPPER(%[1]s) IN ('LP', 'LIB') THEN 1
		WHEN UPPER(%[1]s) = 'LNP' THEN 2
		WHEN UPPER(%[1]s) = 'CLP' THEN 3
		WHEN UPPER(%[1]s) IN ('NP', 'NAT') THEN 4
		WHEN UPPER(%[1]s) = 'GRN' THEN 5
		WHEN UPPER(%[1]s) = 'IND' THEN 6
		WHEN UPPER(%[1]s) IN ('ON', 'PHON') THEN 7
		WHEN UPPER(%[1]s) = 'KAP' THEN 8
		WHEN UPPER(%[1]s) IN ('XEN', 'CA') THEN 9
		WHEN UPPER(%[1]s) = 'JLN' THEN 10
		WHEN UPPER(%[1]s) IN ('UAP', 'UAP [2018]') THEN 11
		WHEN UPPER(%[1]s) = 'PUP' THEN 12
		WHEN UPPER(%[1]s) = 'NXT' THEN 13
		WHEN UPPER(%[1]s) = 'LDP' THEN 14
		WHEN UPPER(%[1]s) = 'SFF' THEN 15
		WHEN UPPER(%[1]s) = 'AC' THEN 16
		WHEN UPPER(%[1]s) = 'AJP' THEN 17
		WHEN UPPER(%[1]s) = 'DHJP' THEN 18
		WHEN UPPER(%[1]s) IN ('FF', 'FFP') THEN 19
		WHEN UPPER(%[1]s) = 'DLP' THEN 20
		WHEN UPPER(%[1]s) = 'GLT' THEN 21
		WHEN UPPER(%[1]s) = 'AMEP' THEN 22
		WHEN UPPER(%[1]s) = 'AV' THEN 23
		ELSE 24 END`, column)
}

// SupportedSuburbMetricKeys returns the complete closed vocabulary in stable
// lexical order.
func SupportedSuburbMetricKeys() []string {
	keys := make([]string, 0, len(suburbMetricRegistry))
	for key := range suburbMetricRegistry {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func lookupSuburbMetric(key string) (suburbMetricDefinition, bool) {
	definition, ok := suburbMetricRegistry[key]
	return definition, ok
}

// ValidateSuburbMetricKeys verifies every key against the closed registry and
// preserves caller order. Exact spelling is intentional: these keys are a
// public vocabulary shared with highlight-metrics.ts.
func ValidateSuburbMetricKeys(keys []string) ([]string, error) {
	validated := make([]string, len(keys))
	for i, key := range keys {
		if _, ok := lookupSuburbMetric(key); !ok {
			return nil, fmt.Errorf("%w: %q", ErrUnknownSuburbMetricKey, key)
		}
		validated[i] = key
	}
	return validated, nil
}

// SuburbIndexEntryRow is one position in a state's stable, sal_code-ordered
// suburb index.
type SuburbIndexEntryRow struct {
	SALCode  string
	SALName  string
	Postcode string
}

type SuburbIndexResult struct {
	Suburbs      []*SuburbIndexEntryRow
	IndexVersion string
}

// SuburbMetricColumnRow contains one float32 column aligned to the state index.
// NullMask bit i = 1 means Values[i] is absent; the zero placeholder must be
// ignored. CategoryLabels, when non-empty, maps integer values to labels.
type SuburbMetricColumnRow struct {
	Key            string
	Values         []float32
	NullMask       []byte
	CategoryLabels []string
}

type SuburbMetricColumnsResult struct {
	Columns      []*SuburbMetricColumnRow
	IndexVersion string
}

type SuburbMetricPredicateRow struct {
	MetricKey string
	Min       *float32
	Max       *float32
}

type SuburbFilterResult struct {
	MatchMask    []byte
	MatchCount   uint32
	IndexVersion string
}

func suburbIndexVersion(salCodes []string) string {
	ordered := append([]string(nil), salCodes...)
	sort.Strings(ordered)
	hash := sha256.New()
	for _, code := range ordered {
		_, _ = fmt.Fprintf(hash, "%d:%s;", len(code), code)
	}
	return fmt.Sprintf("v1-%x", hash.Sum(nil)[:6])
}

func appendMetricValue(column *SuburbMetricColumnRow, value float64, valid bool) {
	index := len(column.Values)
	column.Values = append(column.Values, float32(value))
	if !valid {
		setBit(&column.NullMask, index)
	}
}

func finalizeMetricNullMasks(columns []*SuburbMetricColumnRow) {
	for _, column := range columns {
		required := (len(column.Values) + 7) / 8
		for len(column.NullMask) < required {
			column.NullMask = append(column.NullMask, 0)
		}
	}
}

// Bitsets are least-significant-bit first: row i is byte i/8, bit i%8.
func setBit(mask *[]byte, index int) {
	for len(*mask) <= index/8 {
		*mask = append(*mask, 0)
	}
	(*mask)[index/8] |= byte(1 << uint(index%8))
}

func bitIsSet(mask []byte, index int) bool {
	return index >= 0 && index/8 < len(mask) && mask[index/8]&(1<<uint(index%8)) != 0
}

func buildSuburbMetricQuery(keys []string) (string, []suburbMetricDefinition, error) {
	validated, err := ValidateSuburbMetricKeys(keys)
	if err != nil {
		return "", nil, err
	}
	definitions := make([]suburbMetricDefinition, 0, len(validated))
	selects := []string{"d.sal_code"}
	var joins suburbMetricJoin
	for i, key := range validated {
		definition, _ := lookupSuburbMetric(key)
		definitions = append(definitions, definition)
		selects = append(selects, fmt.Sprintf("(%s)::double precision AS metric_%d", definition.expression, i))
		joins |= definition.joins
	}

	var query strings.Builder
	query.WriteString("SELECT ")
	query.WriteString(strings.Join(selects, ",\n       "))
	query.WriteString("\nFROM suburb_demographics d")
	if joins&suburbMetricJoinPrice != 0 {
		query.WriteString(preferredSuburbRegionJoin)
	}
	if joins&suburbMetricJoinAmenities != 0 {
		query.WriteString("\nLEFT JOIN suburb_amenities a ON a.sal_code = d.sal_code")
	}
	if joins&suburbMetricJoinConnectivity != 0 {
		query.WriteString("\nLEFT JOIN suburb_connectivity c ON c.sal_code = d.sal_code")
	}
	if joins&suburbMetricJoinRegister != 0 {
		query.WriteString("\nLEFT JOIN mv_register_suburb_property rp ON rp.sal_code = d.sal_code")
	}
	if joins&suburbMetricJoinCrime != 0 {
		query.WriteString(listStateSuburbsCrimeJoin)
	}
	query.WriteString("\nWHERE d.state_code = $1\nORDER BY d.sal_code")
	return query.String(), definitions, nil
}

const suburbIndexQuery = `
		SELECT sal_code, sal_name, COALESCE(postcode, '')
		FROM suburb_demographics
		WHERE state_code = $1
		ORDER BY sal_code`

func (s *postgresStore) GetSuburbIndex(stateCode string) (*SuburbIndexResult, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	rows, err := s.db.Query(ctx, suburbIndexQuery, stateCode)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	result := &SuburbIndexResult{}
	var salCodes []string
	for rows.Next() {
		entry := &SuburbIndexEntryRow{}
		if err := rows.Scan(&entry.SALCode, &entry.SALName, &entry.Postcode); err != nil {
			return nil, err
		}
		result.Suburbs = append(result.Suburbs, entry)
		salCodes = append(salCodes, entry.SALCode)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	result.IndexVersion = suburbIndexVersion(salCodes)
	return result, nil
}

func (s *postgresStore) GetSuburbMetricColumns(stateCode string, metricKeys []string) (*SuburbMetricColumnsResult, error) {
	columns, salCodes, err := s.querySuburbMetricColumns(stateCode, metricKeys)
	if err != nil {
		return nil, err
	}
	return &SuburbMetricColumnsResult{Columns: columns, IndexVersion: suburbIndexVersion(salCodes)}, nil
}

func (s *postgresStore) querySuburbMetricColumns(stateCode string, metricKeys []string) ([]*SuburbMetricColumnRow, []string, error) {
	query, definitions, err := buildSuburbMetricQuery(metricKeys)
	if err != nil {
		return nil, nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	rows, err := s.db.Query(ctx, query, stateCode)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()

	columns := make([]*SuburbMetricColumnRow, len(definitions))
	for i, definition := range definitions {
		columns[i] = &SuburbMetricColumnRow{
			Key:            definition.key,
			CategoryLabels: append([]string(nil), definition.categories...),
		}
	}
	var salCodes []string
	for rows.Next() {
		var salCode string
		values := make([]sql.NullFloat64, len(columns))
		destinations := make([]any, 1, len(columns)+1)
		destinations[0] = &salCode
		for i := range values {
			destinations = append(destinations, &values[i])
		}
		if err := rows.Scan(destinations...); err != nil {
			return nil, nil, err
		}
		salCodes = append(salCodes, salCode)
		for i, value := range values {
			appendMetricValue(columns[i], value.Float64, value.Valid)
		}
	}
	if err := rows.Err(); err != nil {
		return nil, nil, err
	}
	finalizeMetricNullMasks(columns)
	return columns, salCodes, nil
}

func (s *postgresStore) FilterSuburbs(stateCode string, predicates []SuburbMetricPredicateRow) (*SuburbFilterResult, error) {
	if err := ValidateSuburbMetricPredicates(predicates); err != nil {
		return nil, err
	}
	keys := make([]string, 0, len(predicates))
	seen := make(map[string]struct{}, len(predicates))
	for _, predicate := range predicates {
		if _, ok := seen[predicate.MetricKey]; !ok {
			keys = append(keys, predicate.MetricKey)
			seen[predicate.MetricKey] = struct{}{}
		}
	}
	columns, salCodes, err := s.querySuburbMetricColumns(stateCode, keys)
	if err != nil {
		return nil, err
	}
	mask, count, err := filterSuburbMetricColumns(columns, predicates)
	if err != nil {
		return nil, err
	}
	return &SuburbFilterResult{MatchMask: mask, MatchCount: count, IndexVersion: suburbIndexVersion(salCodes)}, nil
}

func filterSuburbMetricColumns(columns []*SuburbMetricColumnRow, predicates []SuburbMetricPredicateRow) ([]byte, uint32, error) {
	if err := ValidateSuburbMetricPredicates(predicates); err != nil {
		return nil, 0, err
	}
	byKey := make(map[string]*SuburbMetricColumnRow, len(columns))
	rowCount := 0
	for _, column := range columns {
		if rowCount == 0 {
			rowCount = len(column.Values)
		} else if len(column.Values) != rowCount {
			return nil, 0, fmt.Errorf("metric columns are not aligned")
		}
		byKey[column.Key] = column
	}
	for _, predicate := range predicates {
		if _, ok := byKey[predicate.MetricKey]; !ok {
			return nil, 0, fmt.Errorf("metric column %q is missing", predicate.MetricKey)
		}
	}

	mask := make([]byte, (rowCount+7)/8)
	var count uint32
	for row := 0; row < rowCount; row++ {
		matched := true
		for _, predicate := range predicates {
			column := byKey[predicate.MetricKey]
			if bitIsSet(column.NullMask, row) {
				matched = false
				break
			}
			value := column.Values[row]
			if predicate.Min != nil && value < *predicate.Min || predicate.Max != nil && value > *predicate.Max {
				matched = false
				break
			}
		}
		if matched {
			setBit(&mask, row)
			count++
		}
	}
	return mask, count, nil
}

// ValidateSuburbMetricPredicates validates the complete filter before the store
// opens a database query. Range bounds are inclusive.
func ValidateSuburbMetricPredicates(predicates []SuburbMetricPredicateRow) error {
	if len(predicates) == 0 {
		return fmt.Errorf("at least one predicate is required")
	}
	for _, predicate := range predicates {
		if _, ok := lookupSuburbMetric(predicate.MetricKey); !ok {
			return fmt.Errorf("%w: %q", ErrUnknownSuburbMetricKey, predicate.MetricKey)
		}
		if predicate.Min == nil && predicate.Max == nil {
			return fmt.Errorf("predicate %q requires min or max", predicate.MetricKey)
		}
		if predicate.Min != nil && (math.IsNaN(float64(*predicate.Min)) || math.IsInf(float64(*predicate.Min), 0)) {
			return fmt.Errorf("predicate %q has invalid min", predicate.MetricKey)
		}
		if predicate.Max != nil && (math.IsNaN(float64(*predicate.Max)) || math.IsInf(float64(*predicate.Max), 0)) {
			return fmt.Errorf("predicate %q has invalid max", predicate.MetricKey)
		}
		if predicate.Min != nil && predicate.Max != nil && *predicate.Min > *predicate.Max {
			return fmt.Errorf("predicate %q min exceeds max", predicate.MetricKey)
		}
	}
	return nil
}
