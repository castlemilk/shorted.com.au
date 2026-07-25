package main

// Person identity for the register crawl.
//
// Same-surname members across five parliaments are the worst failure mode in
// this domain: a collision silently merges two people's declared interests under
// one name. So identity is a PERSON with many TERMS, keyed on a normalised
// person_key rather than on a filename or a display string.
//
// aph_mpid is a genuinely stable person id (verified: Barnaby Joyce is 'e5d'
// across both his Senate and House service) but it does NOT appear on the
// Register listing pages, so reaching it is itself a name join. Nothing here
// depends on it.

import (
	"fmt"
	"regexp"
	"strings"
)

// honorifics are stripped before a name becomes a key. The listing writes them
// inconsistently ("Hon", "The Hon", "Hon Dr", "Professor").
var honorifics = map[string]bool{
	"THE": true, "HON": true, "MR": true, "MRS": true, "MS": true, "MISS": true,
	"DR": true, "PROF": true, "PROFESSOR": true, "SENATOR": true, "RT": true,
}

// postNominals appear glued to the SURNAME field, e.g.
// "Alexander OAM, Mr John". Left in place they would fork one person into two.
var postNominals = map[string]bool{
	"AM": true, "AO": true, "AC": true, "OAM": true, "AFC": true, "APM": true,
	"CSC": true, "DSC": true, "KC": true, "QC": true, "SC": true, "MP": true,
	"MBE": true, "OBE": true, "CBE": true, "PSM": true, "RFD": true, "ED": true,
	"JP": true, "PHD": true,
}

// nameSplitRe strips everything that is not a letter or digit, so a surname's
// punctuation cannot fork one person into two keys.
var nameSplitRe = regexp.MustCompile(`[^A-Za-z0-9]+`)
var slugCleanRe = regexp.MustCompile(`[^a-z0-9]+`)

// PersonIdentity is what a listing name cell yields.
type PersonIdentity struct {
	PersonKey   string // 'ALBANESE|ANTHONY'
	Surname     string
	GivenNames  string
	Honorific   string
	DisplayName string
	SlugBase    string // 'anthony-albanese' before collision handling
}

// parseMemberHint reads a House listing name cell.
//
// Observed shapes:
//
//	"Albanese, Hon Anthony, Member for Grayndler, NSW"
//	"O'Brien, Mr Llew, Member for Wide Bay, QLD"
//	"Alexander OAM, Mr John, Member for Bennelong, NSW"   <- post-nominal on the surname
//	"Kelly, Hon Dr Mike, Member for Eden-Monaro, NSW¹"    <- footnote marker
func parseMemberHint(hint string) PersonIdentity {
	parts := strings.Split(hint, ",")
	if len(parts) == 0 {
		return PersonIdentity{}
	}

	surname := cleanNameField(parts[0], true)

	given, honorific := "", ""
	for _, part := range parts[1:] {
		part = strings.TrimSpace(part)
		if part == "" || memberPhraseRe.MatchString(part) {
			continue
		}
		if _, ok := normaliseStateToken(part); ok {
			continue
		}
		given, honorific = splitHonorific(part)
		break
	}

	id := PersonIdentity{
		Surname:    surname,
		GivenNames: given,
		Honorific:  honorific,
	}
	id.PersonKey = personKey(surname, given)
	id.DisplayName = strings.TrimSpace(strings.TrimSpace(given) + " " + surname)
	if id.DisplayName == "" {
		id.DisplayName = surname
	}
	id.SlugBase = slugify(given + " " + surname)
	return id
}

// cleanNameField strips footnote markers and, for the surname field, trailing
// post-nominals.
func cleanNameField(raw string, dropPostNominals bool) string {
	s := strings.TrimSpace(strings.TrimRight(strings.TrimSpace(raw), footnoteMarkers))
	if !dropPostNominals {
		return s
	}
	tokens := strings.Fields(s)
	for len(tokens) > 1 && postNominals[strings.ToUpper(strings.Trim(tokens[len(tokens)-1], ".,"))] {
		tokens = tokens[:len(tokens)-1]
	}
	return strings.Join(tokens, " ")
}

// splitHonorific separates "Hon Dr Mike" into ("Mike", "Hon Dr").
func splitHonorific(raw string) (given, honorific string) {
	tokens := strings.Fields(cleanNameField(raw, false))
	var hon []string
	i := 0
	for ; i < len(tokens); i++ {
		if honorifics[strings.ToUpper(strings.Trim(tokens[i], "."))] {
			hon = append(hon, tokens[i])
			continue
		}
		break
	}
	return strings.Join(tokens[i:], " "), strings.Join(hon, " ")
}

// personKey is the durable identity.
//
// Two normalisations, each guarding a real way one member becomes two:
//
//  1. Only the FIRST given name is kept. The listing writes "Anthony" in one
//     parliament and "Anthony Norman" in another; keying on the full string
//     splits a member's declared history in half.
//  2. ALL punctuation is stripped, so "O'Brien", "OBrien" and "O Brien" collapse
//     to one key, as do "Ananda-Rajah" and "AnandaRajah". Two distinct members
//     whose surnames differ only in punctuation is not a real scenario; the same
//     member spelled two ways very much is.
func personKey(surname, given string) string {
	s := nameSplitRe.ReplaceAllString(strings.ToUpper(strings.TrimSpace(surname)), "")
	if s == "" {
		return ""
	}
	first := ""
	if fields := strings.Fields(strings.ToUpper(given)); len(fields) > 0 {
		first = nameSplitRe.ReplaceAllString(fields[0], "")
	}
	return s + "|" + first
}

func slugify(s string) string {
	out := slugCleanRe.ReplaceAllString(strings.ToLower(strings.TrimSpace(s)), "-")
	return strings.Trim(out, "-")
}

// slugCandidates yields slugs in preference order for a person, so a collision
// falls back deterministically rather than by insertion accident.
//
// Slugs are minted ONCE and never reassigned: they reach OG images, the sitemap
// and editorial cross-links, so a later renumbering is a broken URL.
func slugCandidates(id PersonIdentity, stateHint string) []string {
	base := id.SlugBase
	if base == "" {
		base = slugify(id.Surname)
	}
	out := []string{base}
	if st := strings.ToLower(strings.TrimSpace(stateHint)); st != "" {
		out = append(out, base+"-"+st)
	}
	for i := 2; i <= 9; i++ {
		out = append(out, fmt.Sprintf("%s-%d", base, i))
	}
	return out
}
