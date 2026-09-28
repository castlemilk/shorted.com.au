package extractiontrust

import (
	"regexp"
	"strings"
)

// Entity matching: whether a document's stated entity
// (DocumentMeta.Entity) can be the company a code belongs to. ONE rule for
// every reader of document_meta: the picks filings ingest (gate 1 of contract
// 4.2) and the stock page's latest filing summary (contract 5.1). Two rules
// used to disagree on the same document, so the ingest could withhold a
// foreign entity's figures while the stock page summarised its results.

// entityStopTokens carry no identity: legal forms and connectives.
var entityStopTokens = map[string]bool{
	"limited": true, "ltd": true, "plc": true, "inc": true, "incorporated": true,
	"corporation": true, "corp": true, "co": true, "company": true, "nl": true,
	"pty": true, "the": true, "of": true, "and": true, "group": true,
	"holdings": true, "holding": true, "trust": true, "fund": true, "fpo": true,
	"stapled": true, "securities": true, "abn": true,
}

// entityGenericTokens identify an industry, not a company: a shared generic
// token alone is not a match ("Quokka Minerals" is not "Northern Minerals").
var entityGenericTokens = map[string]bool{
	"australia": true, "australian": true, "resources": true, "energy": true,
	"minerals": true, "mining": true, "metals": true, "gold": true,
	"lithium": true, "oil": true, "gas": true, "capital": true,
	"technologies": true, "technology": true, "tech": true, "health": true,
	"healthcare": true, "international": true, "global": true, "pacific": true,
	"investments": true, "investment": true, "property": true,
	"properties": true, "industries": true, "bank": true, "financial": true,
	"services": true, "solutions": true, "systems": true, "exploration": true,
	"asia": true, "new": true, "zealand": true,
}

var entityTokenSplit = regexp.MustCompile(`[^a-z0-9]+`)

// entityTokens is a name's identifying token set: Normalise (curly quotes,
// case), apostrophes removed ("Domino's" -> "dominos"), split on anything not
// alphanumeric, stop tokens dropped.
func entityTokens(name string) map[string]bool {
	n := strings.ReplaceAll(Normalise(name), "'", "")
	out := map[string]bool{}
	for _, t := range entityTokenSplit.Split(n, -1) {
		if t != "" && !entityStopTokens[t] {
			out[t] = true
		}
	}
	return out
}

// EntityMatches reports whether a document's stated entity can be the
// company (contract 4.2 gate 1: "normalised token overlap"). It matches when
// the two names share a token that is not merely an industry word AND the
// shared tokens are a strict majority of the smaller name's tokens. A name
// with no identifying token never matches, and neither does an empty company
// name: withhold rather than guess.
//
//	"BHP Group Limited" / "BHP GROUP LIMITED"               match
//	"Fortescue Ltd" / "FORTESCUE METALS GROUP LTD"          match
//	"Winsome Resources Limited" / "Lifestyle Communities"   no match
//	"Star Entertainment" / "Northern Star Resources"        no match (1 of 2)
func EntityMatches(entity, companyName string) bool {
	a, b := entityTokens(entity), entityTokens(companyName)
	if len(a) == 0 || len(b) == 0 {
		return false
	}
	shared, distinctive := 0, false
	for t := range a {
		if b[t] {
			shared++
			if !entityGenericTokens[t] {
				distinctive = true
			}
		}
	}
	smaller := len(a)
	if len(b) < smaller {
		smaller = len(b)
	}
	return distinctive && shared*2 > smaller
}
