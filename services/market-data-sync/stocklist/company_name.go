package stocklist

import (
	"regexp"
	"strings"
)

// cleanCompanyName turns a raw ASIC/ASX product name into a display-ready
// company name. It mirrors web/src/@/lib/company-name.ts formatCompanyName so
// the stored/served name matches what the frontend would repair at display
// time: trailing security/entity suffixes are stripped (they can stack), a
// SHOUTED source is title-cased with short all-caps acronyms (BHP, CSL, AGL)
// kept uppercase and minor words lowercased, and a word equal to the stock
// code always renders uppercase. A mixed-case source keeps its casing.
//
// NOTE: services/shorts/internal/store/shorts/company_name.go is an identical
// copy (separate Go module, no shared package) — change both together.
// securityTypeRe marks where instrument metadata begins in the ASIC PRODUCT
// field, which is `<company name> <security type> [qualifiers...]`:
// "FIDUCIAN GROUP LTD ORDINARY FULLY PAID", "LENDLEASE GROUP FPO/UNITS
// STAPLED", "BLOCK INC CDI 1:1 NYSE", "GRAINCORP LIMITED A CLASS ORDINARY".
// Everything from the FIRST security-type token onward is instrument detail,
// never part of the company name. The trailing guard is "not followed by a
// letter" so the space-less "CDI1:1FOREXEMPT NYSE" form matches too.
// Measured over 819 live ASIC names: residual descriptors 10.5%% -> 0%%.
var trailingParenRe = regexp.MustCompile(`\s*\([^()]*\)$`)

var securityTypeRe = regexp.MustCompile(`(?i)[\s,]+(ORDINARY|ORD|FPO|CDI|UNITS?|STAPLED|NOTES?|[A-Z]\s+CLASS)([^A-Za-z]|$)`)

func cleanCompanyName(name, stockCode string) string {
	code := strings.ToUpper(strings.TrimSpace(stockCode))
	cleaned := strings.TrimSpace(name)
	if cleaned == "" {
		// Keep empty empty: the stocklist upsert relies on NULLIF(name, '')
		// to avoid clobbering an existing good name.
		return ""
	}

	// Cut the instrument-metadata tail first, so the entity-suffix strip below
	// sees a real trailing suffix ("SALUDA MEDICAL, INC. CDI USPROHEXCLQIB" ->
	// "SALUDA MEDICAL, INC." -> "Saluda Medical"). Never cut to nothing.
	if loc := securityTypeRe.FindStringIndex(cleaned); loc != nil && loc[0] > 0 {
		if head := strings.TrimSpace(cleaned[:loc[0]]); head != "" {
			cleaned = head
		}
	}

	// Corporate-entity suffixes add nothing to a display heading. They stack
	// ("… CORPORATION LIMITED"), so trim until nothing changes.
	suffixes := []string{
		"ORDINARY", "ORD", "CDI 1:1", "CDI",
		"LIMITED", "LTD", "CORPORATION", "CORP",
		"INCORPORATED", "INC", "PLC", "NL",
	}
	// A trailing full stop ("AGL Energy Limited.") would otherwise block the
	// suffix match, so drop trailing punctuation on each pass.
	for {
		trimmed := strings.TrimRight(cleaned, " .")
		// A trailing parenthetical is a disambiguator, not part of the name,
		// and it blocks the suffix match below:
		// "Environmental Group Limited (The)" -> "Environmental Group".
		trimmed = strings.TrimSpace(trailingParenRe.ReplaceAllString(trimmed, ""))
		upper := strings.ToUpper(trimmed)
		for _, s := range suffixes {
			if strings.HasSuffix(upper, " "+s) || strings.HasSuffix(upper, ","+s) {
				trimmed = strings.TrimRight(trimmed[:len(trimmed)-len(s)], " ,")
				break
			}
		}
		if trimmed == cleaned {
			break
		}
		cleaned = trimmed
	}
	if cleaned == "" {
		cleaned = strings.TrimSpace(name)
	}

	// Re-case when the source carries NO case information of its own -- either
	// SHOUTED ("BHP GROUP") or entirely lower-case ("4dmedical", what the
	// pre-fix title-caser stored for digit-leading names). A genuinely
	// mixed-case name is assumed to be intentional and is left alone.
	isShouting := cleaned == strings.ToUpper(cleaned)
	isWhispering := cleaned == strings.ToLower(cleaned)
	needsRecasing := isShouting || isWhispering

	var b strings.Builder
	wordIndex := -1
	parts := splitCompanyTokens(cleaned)
	for i, token := range parts {
		if !strings.ContainsFunc(token, isASCIILetter) {
			b.WriteString(token) // separators / numbers
			continue
		}
		wordIndex++
		upperToken := strings.ToUpper(token)
		// A lone letter straight after an apostrophe is a possessive or
		// contraction suffix, never an acronym: "DOMINO'S" -> "Domino's".
		// Applied even to a mixed-case source, because English never
		// capitalises it.
		if wordIndex > 0 && len(token) == 1 && i > 0 && endsWithApostrophe(parts[i-1]) {
			b.WriteString(strings.ToLower(token))
			continue
		}
		switch {
		case code != "" && upperToken == code && (isShouting || isAcronymLike(token)):
			b.WriteString(code)
		case !needsRecasing:
			b.WriteString(token)
		case isMinorWord(token):
			// Leading minor word is title-cased ("THE A2 MILK" -> "The A2
			// Milk"), not lowercased and not treated as a short acronym.
			if wordIndex == 0 {
				b.WriteString(titleCaseWord(token))
			} else {
				b.WriteString(strings.ToLower(token))
			}
		case isShouting && len(token) <= 3:
			// Short all-caps acronyms in a shouted source stay uppercase.
			b.WriteString(upperToken)
		default:
			b.WriteString(titleCaseWord(token))
		}
	}
	return b.String()
}

// endsWithApostrophe reports whether a separator run ends in an apostrophe
// (straight or typographic).
func endsWithApostrophe(sep string) bool {
	return strings.HasSuffix(sep, "'") || strings.HasSuffix(sep, "\u2019")
}

func isASCIILetter(r rune) bool {
	return (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z')
}

func isAlphaNum(r rune) bool {
	return isASCIILetter(r) || (r >= '0' && r <= '9')
}

// splitCompanyTokens splits into alternating alphanumeric words and separator
// runs, preserving both (mirrors the /([^A-Za-z0-9]+)/ split in the web copy).
func splitCompanyTokens(s string) []string {
	var tokens []string
	start := 0
	var inWord bool
	for i, r := range s {
		w := isAlphaNum(r)
		if i == 0 {
			inWord = w
			continue
		}
		if w != inWord {
			tokens = append(tokens, s[start:i])
			start = i
			inWord = w
		}
	}
	if start < len(s) {
		tokens = append(tokens, s[start:])
	}
	return tokens
}

// Lowercased inside a title-cased name (never as the first word).
func isMinorWord(w string) bool {
	switch strings.ToLower(w) {
	case "of", "and", "the", "for", "in", "on", "de":
		return true
	}
	return false
}

// isAcronymLike reports whether a word looks like a mangled acronym rather
// than a real word: no vowel after the first letter ("Bhp", "Csl") — keeps
// the code-match rule from SHOUTING legitimate names like "Rio Tinto".
func isAcronymLike(w string) bool {
	return !strings.ContainsAny(w[1:], "aeiouAEIOU")
}

// titleCaseWord upper-cases the first LETTER, not the first character — a
// token can start with a digit ("4DMEDICAL"), and capitalising position 0
// there would leave the whole word lowercase ("4dmedical").
func titleCaseWord(w string) string {
	i := strings.IndexFunc(w, isASCIILetter)
	if i < 0 {
		return w
	}
	return w[:i] + strings.ToUpper(w[i:i+1]) + strings.ToLower(w[i+1:])
}
