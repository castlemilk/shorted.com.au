package main

import (
	"archive/zip"
	"fmt"
	"strconv"
	"strings"
)

// ABS 2021 Census GCP SAL: religion (G14) + language used at home (G13A-E).
// These drive the suburb map's categorical "highlight" toggle (dominant religion,
// top language other than English).
const censusG14Entry = "2021 Census GCP Suburbs and Localities for AUS/2021Census_G14_AUST_SAL.csv"

var censusG13Entries = []string{
	"2021 Census GCP Suburbs and Localities for AUS/2021Census_G13A_AUST_SAL.csv",
	"2021 Census GCP Suburbs and Localities for AUS/2021Census_G13B_AUST_SAL.csv",
	"2021 Census GCP Suburbs and Localities for AUS/2021Census_G13C_AUST_SAL.csv",
	"2021 Census GCP Suburbs and Localities for AUS/2021Census_G13D_AUST_SAL.csv",
	"2021 Census GCP Suburbs and Localities for AUS/2021Census_G13E_AUST_SAL.csv",
}

// atoiCell parses an ABS count cell; blank/unparseable → 0 (ABS suppresses small
// cells to 0, the right additive identity for an argmax over categories).
func atoiCell(s string) int {
	v, err := strconv.Atoi(strings.TrimSpace(s))
	if err != nil {
		return 0
	}
	return v
}

// pctOf returns 100*part/whole, or nil when the base is empty (suppressed).
func pctOf(part, whole int) *float64 {
	if whole <= 0 {
		return nil
	}
	p := float64(part) / float64(whole) * 100
	return &p
}

// --- Religion (G14) ---

type religionStats struct {
	top      string
	pctTop   *float64
	pctNoRel *float64
}

// parseG14 → per bare SAL code: dominant religious affiliation + its share, plus
// the "no religion" share. Christianity is split into Catholic / Anglican / Other
// Christian; the remaining major affiliations each map to one headline label.
func parseG14(rows [][]string) (map[string]religionStats, error) {
	if len(rows) < 2 {
		return nil, fmt.Errorf("G14: no data rows")
	}
	c := csvColIndex(rows[0])
	need := []string{
		"SAL_CODE_2021", "Buddhism_P", "Christianity_Anglican_P", "Christianity_Catholic_P",
		"Christianity_Tot_P", "Hinduism_P", "Islam_P", "Judaism_P",
		"Other_Religions_Tot_P", "SB_OSB_NRA_NR_P", "Tot_P",
	}
	for _, n := range need {
		if _, ok := c[n]; !ok {
			return nil, fmt.Errorf("G14: missing %s column", n)
		}
	}
	out := make(map[string]religionStats, len(rows))
	for _, row := range rows[1:] {
		code := stripSALPrefix(cell(row, c["SAL_CODE_2021"]))
		if code == "" {
			continue
		}
		catholic := atoiCell(cell(row, c["Christianity_Catholic_P"]))
		anglican := atoiCell(cell(row, c["Christianity_Anglican_P"]))
		othChristian := atoiCell(cell(row, c["Christianity_Tot_P"])) - catholic - anglican
		if othChristian < 0 {
			othChristian = 0
		}
		noRel := atoiCell(cell(row, c["SB_OSB_NRA_NR_P"]))
		totP := atoiCell(cell(row, c["Tot_P"]))
		cats := []struct {
			label string
			n     int
		}{
			{"Catholic", catholic},
			{"Anglican", anglican},
			{"Other Christian", othChristian},
			{"No religion", noRel},
			{"Islam", atoiCell(cell(row, c["Islam_P"]))},
			{"Hinduism", atoiCell(cell(row, c["Hinduism_P"]))},
			{"Buddhism", atoiCell(cell(row, c["Buddhism_P"]))},
			{"Judaism", atoiCell(cell(row, c["Judaism_P"]))},
			{"Other", atoiCell(cell(row, c["Other_Religions_Tot_P"]))},
		}
		top, topN := "", 0
		for _, cat := range cats {
			if cat.n > topN {
				top, topN = cat.label, cat.n
			}
		}
		if top == "" || totP <= 0 {
			continue
		}
		out[code] = religionStats{
			top:      top,
			pctTop:   pctOf(topN, totP),
			pctNoRel: pctOf(noRel, totP),
		}
	}
	return out, nil
}

// --- Language used at home (G13A-E) ---

type languageStats struct {
	top   string
	count int
}

// langDisplay maps a G13 short-header inner key (column minus MOL_ prefix and
// _Tot suffix) to a human language name. Unmapped individual languages fall back
// to a cleaned key, so a future ABS code still surfaces a sensible label.
var langDisplay = map[string]string{
	"Afrikaans": "Afrikaans", "AIndLng": "Australian Indigenous languages", "Arabic": "Arabic",
	"CL_Canton": "Cantonese", "CL_Mandarin": "Mandarin", "Croatian": "Croatian",
	"French": "French", "German": "German", "Greek": "Greek",
	"IAL_Bengali": "Bengali", "IAL_Guj": "Gujarati", "IAL_Hindi": "Hindi", "IAL_Nepali": "Nepali",
	"IAL_Punjabi": "Punjabi", "IAL_Sinhal": "Sinhalese", "IAL_Urdu": "Urdu",
	"Italian": "Italian", "Japan": "Japanese", "Khmer": "Khmer", "Korean": "Korean",
	"Macedon": "Macedonian", "Malayalam": "Malayalam", "Persian_ED": "Persian",
	"Polish": "Polish", "Portuguese": "Portuguese", "Russian": "Russian",
	"SAL_Filipin": "Filipino", "SAL_Indon": "Indonesian", "SAL_Tagalog": "Tagalog",
	"Samoan": "Samoan", "Serbian": "Serbian", "Spanish": "Spanish", "Tamil": "Tamil",
	"Thai": "Thai", "Turkish": "Turkish", "Vietnamese": "Vietnamese",
}

// languageColumns picks, from a G13 header, the individual-language person-total
// columns (MOL_<lang>_Tot), excluding the English-proficiency sub-totals
// (_UOLSE_Tot), the group rollups (_Tot_Tot) and the catch-all "Other" buckets —
// so a suburb's headline language is always a named language. colIndex → label.
func languageColumns(header []string) map[int]string {
	cols := map[int]string{}
	for i, h := range header {
		h = strings.TrimSpace(h)
		if !strings.HasPrefix(h, "MOL_") || !strings.HasSuffix(h, "_Tot") {
			continue
		}
		inner := strings.TrimSuffix(strings.TrimPrefix(h, "MOL_"), "_Tot")
		switch {
		case inner == "", inner == "Tot", strings.HasSuffix(inner, "_Tot"): // group/grand totals
			continue
		case strings.HasSuffix(inner, "_UOLSE"): // proficiency sub-total, not a language total
			continue
		case inner == "Oth", strings.HasSuffix(inner, "_Oth"): // catch-all buckets
			continue
		}
		name, ok := langDisplay[inner]
		if !ok {
			name = strings.ReplaceAll(
				strings.TrimPrefix(strings.TrimPrefix(strings.TrimPrefix(inner, "CL_"), "IAL_"), "SAL_"),
				"_", " ")
		}
		cols[i] = name
	}
	return cols
}

// parseG13 reads every G13 part and returns, per bare SAL code, the most-spoken
// language other than English at home (with its speaker count).
func parseG13(zr *zip.ReadCloser) (map[string]languageStats, error) {
	best := map[string]languageStats{}
	for _, entry := range censusG13Entries {
		rows, err := readZipCSV(zr, entry)
		if err != nil {
			return nil, err
		}
		if len(rows) < 2 {
			continue
		}
		c := csvColIndex(rows[0])
		codeIdx, ok := c["SAL_CODE_2021"]
		if !ok {
			return nil, fmt.Errorf("G13 %s: missing SAL_CODE_2021", entry)
		}
		langCols := languageColumns(rows[0])
		for _, row := range rows[1:] {
			code := stripSALPrefix(cell(row, codeIdx))
			if code == "" {
				continue
			}
			cur := best[code] // accumulate the max across all G13 parts
			for idx, name := range langCols {
				if n := atoiCell(cell(row, idx)); n > cur.count {
					cur = languageStats{top: name, count: n}
				}
			}
			if cur.count > 0 {
				best[code] = cur
			}
		}
	}
	return best, nil
}
