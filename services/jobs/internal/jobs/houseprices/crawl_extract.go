package houseprices

import (
	"encoding/json"
	"regexp"
	"strconv"
	"strings"

	"github.com/PuerkitoBio/goquery"
)

// Extraction is deliberately schema-AGNOSTIC. realestate.com.au embeds state in
// `window.ArgonautExchange` and domain.com.au in `__NEXT_DATA__`, but the exact
// key paths are unverified and change often — and Kasada serves *deliberately
// different* DOM to bots. So we never bind to a fixed path: we harvest every
// "median sale price"-looking number from every JSON blob on the page and let
// the validator (crawl_validate.go) decide what to trust.

var assignOpenRe = regexp.MustCompile(`=\s*[\{\[]`)

// extractSaleMedians walks every <script> JSON blob and returns all candidate
// median *sale* prices found (rent and non-numeric values excluded).
func extractSaleMedians(doc *goquery.Document) []float64 {
	var out []float64
	doc.Find("script").Each(func(_ int, s *goquery.Selection) {
		for _, blob := range jsonBlobs(s.Text()) {
			var v any
			if err := json.Unmarshal([]byte(blob), &v); err != nil {
				continue
			}
			walkForMedians(v, &out)
		}
	})
	return out
}

func walkForMedians(v any, out *[]float64) {
	switch t := v.(type) {
	case map[string]any:
		for k, child := range t {
			if isSaleMedianKey(k) {
				if n, ok := toMoney(child); ok {
					*out = append(*out, n)
				}
			}
			walkForMedians(child, out)
		}
	case []any:
		for _, child := range t {
			walkForMedians(child, out)
		}
	}
}

// isSaleMedianKey matches keys like medianPrice / medianSoldPrice /
// medianSalePrice, but never rent.
func isSaleMedianKey(k string) bool {
	kl := strings.ToLower(k)
	if !strings.Contains(kl, "median") || strings.Contains(kl, "rent") {
		return false
	}
	return strings.Contains(kl, "price") || strings.Contains(kl, "sold") || strings.Contains(kl, "sale")
}

func toMoney(v any) (float64, bool) {
	switch t := v.(type) {
	case float64:
		return t, t > 0
	case json.Number:
		f, err := t.Float64()
		return f, err == nil && f > 0
	case string:
		return parseMoney(t)
	}
	return 0, false
}

var moneyRe = regexp.MustCompile(`([0-9][0-9,]*\.?[0-9]*)\s*([mk])?`)

// parseMoney handles "$1.25m", "1,250,000", "$985k", "1.2 M".
func parseMoney(s string) (float64, bool) {
	m := moneyRe.FindStringSubmatch(strings.ToLower(strings.TrimSpace(s)))
	if m == nil {
		return 0, false
	}
	num, err := strconv.ParseFloat(strings.ReplaceAll(m[1], ",", ""), 64)
	if err != nil {
		return 0, false
	}
	switch m[2] {
	case "m":
		num *= 1_000_000
	case "k":
		num *= 1_000
	}
	return num, num > 0
}

// jsonBlobs returns candidate JSON object/array substrings from a <script> body:
// the whole body when it's raw JSON (e.g. __NEXT_DATA__), plus any `x = {…}`
// assignment value (e.g. window.ArgonautExchange).
func jsonBlobs(text string) []string {
	var blobs []string
	if t := strings.TrimSpace(text); len(t) > 0 && (t[0] == '{' || t[0] == '[') {
		if b, ok := balancedJSON(t, 0); ok {
			blobs = append(blobs, b)
		}
	}
	for _, loc := range assignOpenRe.FindAllStringIndex(text, -1) {
		if b, ok := balancedJSON(text, loc[1]-1); ok {
			blobs = append(blobs, b)
		}
	}
	return blobs
}

// balancedJSON returns the balanced {…} or […] substring beginning at `start`,
// respecting string literals and escapes (so braces inside strings don't count).
func balancedJSON(s string, start int) (string, bool) {
	if start < 0 || start >= len(s) {
		return "", false
	}
	open := s[start]
	var closer byte
	switch open {
	case '{':
		closer = '}'
	case '[':
		closer = ']'
	default:
		return "", false
	}
	depth, inStr, esc := 0, false, false
	for i := start; i < len(s); i++ {
		c := s[i]
		if inStr {
			switch {
			case esc:
				esc = false
			case c == '\\':
				esc = true
			case c == '"':
				inStr = false
			}
			continue
		}
		switch c {
		case '"':
			inStr = true
		case open:
			depth++
		case closer:
			depth--
			if depth == 0 {
				return s[start : i+1], true
			}
		}
	}
	return "", false
}
