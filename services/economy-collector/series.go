package main

import (
	"strings"
	"time"
)

// SeriesDef is the catalog entry for one economic series. Key() derives the
// stable series_key: topic.metric[.product].region[.adjustment], adjustment
// segment only when not "original".
type SeriesDef struct {
	Topic      string
	Metric     string
	Product    string // optional
	RegionType string // national | state | refinery | industry
	RegionCode string // lowercase: aus | nsw | ...
	RegionName string
	Unit       string
	Frequency  string // monthly | quarterly | annual
	Adjustment string // original | seasadj | trend
	Dimensions map[string]string
	SourceKey  string
	Licence    string
}

func (d SeriesDef) Key() string {
	parts := []string{d.Topic, d.Metric}
	if d.Product != "" {
		parts = append(parts, d.Product)
	}
	parts = append(parts, d.RegionCode)
	if d.Adjustment != "" && d.Adjustment != "original" {
		parts = append(parts, d.Adjustment)
	}
	return strings.Join(parts, ".")
}

// Obs is one observation for a series.
type Obs struct {
	Series SeriesDef
	Period time.Time
	Value  float64
}

// slug lowercases and snake_cases a label for use in keys/products.
func slug(s string) string {
	s = strings.ToLower(strings.TrimSpace(s))
	var b strings.Builder
	prevUnderscore := false
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z' || r >= '0' && r <= '9':
			b.WriteRune(r)
			prevUnderscore = false
		default:
			if !prevUnderscore && b.Len() > 0 {
				b.WriteByte('_')
				prevUnderscore = true
			}
		}
	}
	return strings.TrimSuffix(b.String(), "_")
}
