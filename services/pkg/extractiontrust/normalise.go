package extractiontrust

import "strings"

// foldReplacer maps typographic punctuation that PDF text extraction and ASX
// headlines carry routinely onto its ASCII form, and deletes invisible
// characters, so a headline spelled with a curly apostrophe or an en dash
// compares equal to its ASCII spelling. The Python port mirrors this table
// exactly.
var foldReplacer = strings.NewReplacer(
	// Single quotes, apostrophes and primes.
	"\u2018", "'", "\u2019", "'", "\u201A", "'", "\u201B", "'", "\u2032", "'", "\u00B4", "'",
	// Double quotes and double primes.
	"\u201C", `"`, "\u201D", `"`, "\u201E", `"`, "\u201F", `"`, "\u2033", `"`, "\u00AB", `"`, "\u00BB", `"`,
	// Hyphens, dashes and the minus sign.
	"\u2010", "-", "\u2011", "-", "\u2012", "-", "\u2013", "-", "\u2014", "-", "\u2015", "-",
	"\u2212", "-", "\uFE58", "-", "\uFE63", "-", "\uFF0D", "-",
	// Ellipsis.
	"\u2026", "...",
	// Invisible characters: zero-width space/joiners, word joiner, BOM, soft hyphen.
	"\u200B", "", "\u200C", "", "\u200D", "", "\u2060", "", "\uFEFF", "", "\u00AD", "",
)

// Normalise is the comparison form of a quote or a title: typographic quotes
// and dashes folded to ASCII, invisible characters removed, lower-cased, runs of
// whitespace (including non-breaking and thin spaces) collapsed to one space,
// and trimmed.
func Normalise(s string) string {
	s = foldReplacer.Replace(s)
	s = strings.ToLower(s)
	return strings.Join(strings.Fields(s), " ")
}
