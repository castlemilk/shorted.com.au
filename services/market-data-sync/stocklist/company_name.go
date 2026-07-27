package stocklist

import "strings"

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
func cleanCompanyName(name, stockCode string) string {
	code := strings.ToUpper(strings.TrimSpace(stockCode))
	cleaned := strings.TrimSpace(name)
	if cleaned == "" {
		// Keep empty empty: the stocklist upsert relies on NULLIF(name, '')
		// to avoid clobbering an existing good name.
		return ""
	}

	// Security-type descriptors (ASIC PRODUCT field) and corporate-entity
	// suffixes add nothing to a display heading. They stack ("… CORPORATION
	// LIMITED ORDINARY"), so trim until nothing changes.
	suffixes := []string{
		"ORDINARY", "ORD", "CDI 1:1", "CDI",
		"LIMITED", "LTD", "CORPORATION", "CORP",
		"INCORPORATED", "INC", "PLC", "NL",
	}
	// A trailing full stop ("AGL Energy Limited.") would otherwise block the
	// suffix match, so drop trailing punctuation on each pass.
	for {
		trimmed := strings.TrimRight(cleaned, " .")
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

	// Only re-case a SHOUTED source; mixed case is assumed intentional.
	isShouting := cleaned == strings.ToUpper(cleaned)

	var b strings.Builder
	wordIndex := -1
	for _, token := range splitCompanyTokens(cleaned) {
		if !strings.ContainsFunc(token, isASCIILetter) {
			b.WriteString(token) // separators / numbers
			continue
		}
		wordIndex++
		upperToken := strings.ToUpper(token)
		switch {
		case code != "" && upperToken == code && (isShouting || isAcronymLike(token)):
			b.WriteString(code)
		case !isShouting:
			b.WriteString(token)
		case wordIndex > 0 && isMinorWord(token):
			b.WriteString(strings.ToLower(token))
		case len(token) <= 3:
			// Short all-caps acronyms in a shouted source stay uppercase.
			b.WriteString(upperToken)
		default:
			b.WriteString(titleCaseWord(token))
		}
	}
	return b.String()
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
