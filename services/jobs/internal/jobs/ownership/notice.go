package ownership

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode"
)

// noticeParserVersion is stored with every attempt. Bump it when a change to
// parseSubstantialNotice would read a notice it once refused differently: a
// refused notice whose attempt carries an older version is read again
// (pendingNoticesSQL), a parsed one never is.
const noticeParserVersion = 1

// Form is the statutory form a substantial holding notice was given on.
type Form string

const (
	// Form603 is a notice of initial substantial holder (Corporations Act s671B).
	Form603 Form = "603"
	// Form604 is a notice of change of interests of substantial holder.
	Form604 Form = "604"
	// Form605 is a notice of ceasing to be a substantial holder.
	Form605 Form = "605"
	// FormNZ is a New Zealand Financial Markets Conduct Act disclosure, which a
	// dual-listed company (A2M, FPH) lodges with ASX as well as NZX.
	FormNZ Form = "nz"
)

// Notice is what one substantial holding notice says. Every number is either
// read from the notice or nil: nothing is computed from a guess.
type Notice struct {
	Form Form
	// HolderName is section 1's name as written. "" when it cannot be read.
	HolderName string
	// CompanyName is the "To: Company Name/Scheme" line, when it can be read.
	CompanyName string
	// EventDate is the date the holder became, changed or ceased (YYYY-MM-DD),
	// "" when the notice states none that reads as a date.
	EventDate string
	// PresentPct and PresentVotes are the holder's voting power and votes now.
	// A 605 rarely states them; then they are nil and Ceased says the holding
	// is below 5%.
	PresentPct   *float64
	PresentVotes *int64
	// PreviousPct and PreviousVotes are a 604's (or an NZ movement's)
	// previous notice figures.
	PreviousPct   *float64
	PreviousVotes *int64
	Ceased        bool
}

// Outcome is a parse outcome, stored as the attempt's outcome.
type Outcome string

const (
	outcomeParsed Outcome = "parsed"
	// outcomeNoText: the PDF has no text layer worth reading (a scan: its only
	// text is the ASX "For personal use only" watermark).
	outcomeNoText Outcome = "no_text"
	// outcomeNotNotice: the document is not a substantial holding notice (a
	// covering letter filed alone under a substantial-holding headline).
	outcomeNotNotice Outcome = "not_a_notice"
	// outcomeNoVotingPower: a 603 or 604 whose voting power could not be read
	// unambiguously. Withheld, never guessed.
	outcomeNoVotingPower Outcome = "no_voting_power"
	// outcomeImplausible: a figure was read but contradicts the form (a 603
	// under 5%).
	outcomeImplausible Outcome = "implausible"
)

// loose turns a label into a pattern that survives a text layer's breaks: a
// PDF form often splits a word across two text runs ("Details of subs" /
// "tantial holder", "D" / "etails"), which a layout joins with a space. Each
// letter may be followed by one space; each space in the label is any run of
// spaces.
func loose(label string) string {
	var b strings.Builder
	words := strings.Fields(label)
	for wi, w := range words {
		if wi > 0 {
			b.WriteString(`\s*`)
		}
		rs := []rune(w)
		for i, r := range rs {
			b.WriteString(regexp.QuoteMeta(string(r)))
			if i < len(rs)-1 && (unicode.IsLetter(r) || unicode.IsDigit(r)) {
				b.WriteString(` ?`)
			}
		}
	}
	return b.String()
}

func looseRe(format string, labels ...string) *regexp.Regexp {
	args := make([]any, len(labels))
	for i, l := range labels {
		args[i] = loose(l)
	}
	return regexp.MustCompile(fmt.Sprintf(format, args...))
}

var (
	wsRe = regexp.MustCompile(`\s+`)
	// ASX stamps every page of a released announcement with this; a layout
	// can drop it between a label and its value.
	watermarkRe = regexp.MustCompile(`(?i)For\s+personal\s+use\s+only`)
	// Digit groups a PDF text layer spaced out ("62 , 856 , 312"). Only a
	// comma with space beside it matches, so each pass joins the next group
	// instead of re-matching one already joined.
	spacedCommaRe = regexp.MustCompile(`(\d)(?:\s+,\s*|,\s+)(\d{3})\b`)
	// A percentage whose cell wrapped or whose glyphs sit off the baseline:
	// "5 . 045%", "6.2 4%", "6.0 08 %".
	splitPctRe = regexp.MustCompile(`(\d+)\s*\.\s*(\d+(?:\s+\d+)*)\s*%`)
)

// splitGroupRe is a comma group a text layer broke in two: "110,71 2,219",
// where one glyph of 712 sits on another baseline.
var splitGroupRe = regexp.MustCompile(`,(\d{1,2}) (\d{1,2})([,. %]|$)`)

// joinSplitGroups rejoins a broken comma group when its halves make exactly
// three digits; "1,5 2026" (a date after a number) is left alone because 5
// and 2026 do not.
func joinSplitGroups(s string) string {
	return splitGroupRe.ReplaceAllStringFunc(s, func(m string) string {
		sm := splitGroupRe.FindStringSubmatch(m)
		if len(sm[1])+len(sm[2]) != 3 {
			return m
		}
		return "," + sm[1] + sm[2] + sm[3]
	})
}

// normalizeNoticeText flattens a PDF text layer to one line with single
// spaces, straight quotes, no ASX watermark and rejoined digit groups.
func normalizeNoticeText(text string) string {
	r := strings.NewReplacer(
		"\u2019", "'", "\u2018", "'", "\u201c", `"`, "\u201d", `"`,
		"\u2013", "-", "\u2014", "-", "\u2212", "-", "\x00", "",
	)
	// Cell boundaries from layoutText, and every Unicode space (a thin space
	// inside "62 856 312"), become one ASCII space.
	mapped := strings.Map(func(c rune) rune {
		switch {
		case c == '|', unicode.IsSpace(c), unicode.Is(unicode.Zs, c):
			return ' '
		case c == '\u200b', c == '\ufeff', c == '\ufffd', c == '\uf0b7':
			return -1
		}
		return c
	}, r.Replace(text))
	s := watermarkRe.ReplaceAllString(mapped, " ")
	s = wsRe.ReplaceAllString(s, " ")
	s = joinSplitGroups(s)
	for range 6 {
		joined := spacedCommaRe.ReplaceAllString(s, "$1,$2")
		if joined == s {
			break
		}
		s = joined
	}
	s = splitPctRe.ReplaceAllStringFunc(s, func(m string) string {
		return strings.Join(strings.Fields(m), "")
	})
	return strings.TrimSpace(s)
}

var (
	form603Re = looseRe(`(?i)%s|Form\s*6\s*0\s*3\b`, "notice of initial substantial holder")
	form604Re = looseRe(`(?i)%s\s*(?:share)?\s*h ?o ?l ?d ?e ?r|%s|Form\s*6\s*0\s*4\b`,
		"notice of change of interests of substantial", "notice of changes of interests of substantial")
	form605Re = looseRe(`(?i)%s|Form\s*6\s*0\s*5\b`, "notice of ceasing to be a substantial")
	formNZRe  = regexp.MustCompile(`(?i)substantial product holder|disclosure of (?:beginning to have|movement of 1% or more in|ceasing to have) substantial holding`)
	fmcaRe    = regexp.MustCompile(`(?i)financial markets conduct act`)
)

// formFromText reads the form from the document's own title. The earliest
// title wins: an annexure can quote another form's name. A covering letter
// can come first, so the whole form part is searched.
func formFromText(s string) Form {
	head := s
	if len(head) > 12000 {
		head = head[:12000]
	}
	best, bestAt := Form(""), -1
	consider := func(f Form, re *regexp.Regexp) {
		if loc := re.FindStringIndex(head); loc != nil && (bestAt < 0 || loc[0] < bestAt) {
			best, bestAt = f, loc[0]
		}
	}
	consider(Form603, form603Re)
	consider(Form604, form604Re)
	consider(Form605, form605Re)
	if fmcaRe.MatchString(head) {
		consider(FormNZ, formNZRe)
	}
	return best
}

// formFromHeadline is ASX's title for the notice, the fallback when the
// document's own title is not in its text layer.
func formFromHeadline(headline string) Form {
	h := strings.ToLower(headline)
	switch {
	case strings.Contains(h, "becoming a substantial holder"), strings.Contains(h, "initial substantial"):
		return Form603
	case strings.Contains(h, "ceasing to be a substantial holder"):
		return Form605
	case strings.Contains(h, "change in substantial holding"), strings.Contains(h, "change of interests of substantial"):
		return Form604
	}
	return ""
}

// IsSubstantialHoldingHeadline reports whether an ASX headline is one of the
// three substantial holding notice titles.
func IsSubstantialHoldingHeadline(headline string) bool {
	return formFromHeadline(headline) != ""
}

// Section 1 ends at the first label after the name.
const nameStop = `(?:\(?\s*A ?C ?N\b|\(?\s*A ?B ?N\b|\(?\s*A ?R ?S ?N\b|\(?\s*A ?R ?B ?N\b|\bThe holder became|\bThe holder ceased|\bThere was a change|\bThe previous notice|\bHolder became|\b2\s*\.\s*(?:Details|Previous|Changes))`

var (
	holderNameRe = looseRe(`(?i)(?:%s|%s)\s*(?:\(\s*1\s*\))?\s*:?\s*(?:Name\s*(?:\(s\))?\s*:?\s*)?(.{2,400}?)\s*`+nameStop,
		"details of substantial holder", "details of substantial shareholder")
	nzHolderNameRe = regexp.MustCompile(`(?i)Substantial product holder\(s\) giving disclosure\s*Full name\(s\)\s*:?\s*(.{2,300}?)\s*(?:Summary of substantial holding|$)`)
	companyNameRe  = looseRe(`(?i)\bTo\s*:?\s*(?:%s)\s*/?\s*(?:%s)?\s*:?\s*(.{2,160}?)\s*(?:\(?\s*A ?C ?N\b|\(?\s*A ?B ?N\b|\(?\s*A ?R ?S ?N\b|\b1\s*\.\s*D ?e ?t ?a ?i ?l ?s)`,
		"company name", "scheme")
	nzCompanyRe = regexp.MustCompile(`(?i)\bTo New Zealand Stock Exchange and To\s+(.{2,120}?)\s+Relevant event`)
	// A capital letter a text layer split from the rest of its word
	// ("B ennelong").
	splitCapRe = regexp.MustCompile(`\b([A-Z]) ([a-z]{2,})`)
	// Words that mean section 1's value was never written next to its label.
	labelWords = []string{"the holder became", "the holder ceased", "there was a change", "acn/arsn", "details of", "name"}
)

// cleanHolderName trims the label debris around a section 1 name.
func cleanHolderName(raw string) string {
	s := strings.TrimSpace(splitCapRe.ReplaceAllString(raw, "$1$2"))
	s = strings.Trim(s, " :;,.-\"'()")
	// A label drawn in the middle of a two-line value: "PINNACLE ... (AND ITS
	// SUBSIDIARIES Name LISTED IN ANNEXURE A)".
	s = strings.Replace(s, " Name ", " ", 1)
	lower := strings.ToLower(s)
	for _, w := range labelWords {
		if lower == w || strings.HasPrefix(lower, w+" ") {
			return ""
		}
	}
	letters := 0
	for _, r := range s {
		if unicode.IsLetter(r) {
			letters++
		}
	}
	// A name has letters; a run of digits is an ACN that lost its label.
	if letters < 2 {
		return ""
	}
	if len(s) > 200 {
		s = strings.TrimSpace(s[:200])
	}
	return s
}

// The date a notice gives for its event. A layout can draw the date cell
// beside the label's first line, so the date may sit inside the label.
const dateCap = `(\S.{4,30}?)`

var (
	eventDateRes = []*regexp.Regexp{
		looseRe(`(?i)%s\s*(?:share)?\s*h ?o ?l ?d ?e ?r on\s*:?\s*(.{6,40}?)(?:\s+The\b|\s+2\s*\.|\s+\(|$)`, "became a substantial"),
		looseRe(`(?i)%s\s*(?:share)?\s*h ?o ?l ?d ?e ?r on\s*:?\s*(.{6,40}?)(?:\s+The\b|\s+2\s*\.|\s+\(|$)`, "ceased to be a substantial"),
		looseRe(`(?i)%s\s*(?:share)?\s*h ?o ?l ?d ?e ?r on\s*:?\s*(.{6,40}?)(?:\s+The\b|\s+2\s*\.|\s+\(|$)`, "change in the interests of the substantial"),
		looseRe(`(?i)%s\s+`+dateCap+`\s+%s`, "change in the interests of the", "substantial"),
		looseRe(`(?i)%s\s+`+dateCap+`\s+%s`, "became a", "substantial"),
		looseRe(`(?i)%s\s+`+dateCap+`\s+%s`, "ceased to be a", "substantial"),
	}
	nzEventDateRe = regexp.MustCompile(`(?i)Date of relevant event\s*:?\s*(.{6,40}?)(?:\s+Date\b|$)`)
	dmyNumRe      = regexp.MustCompile(`^(\d{1,2})\s*[/.-]\s*(\d{1,2})\s*[/.-]\s*(\d{2,4})`)
	dmyWordRe     = regexp.MustCompile(`(?i)^(\d{1,2})(?:st|nd|rd|th)?\s*[/ -]?\s*([A-Za-z]{3,9})\s*[/ ,-]?\s*(\d{4})`)
	mdyWordRe     = regexp.MustCompile(`(?i)^([A-Za-z]{3,9})\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})`)
	monthIndex    = map[string]time.Month{
		"jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6,
		"jul": 7, "aug": 8, "sep": 9, "sept": 9, "oct": 10, "nov": 11, "dec": 12,
	}
)

// parseNoticeDate reads the formats notices write a date in: 23/09/2026,
// 0 9 /09/2026, 24/June/2026, 2 October 2026, 15-Oct-2026, October 15, 2026.
func parseNoticeDate(raw string) string {
	if d := parseNoticeDateExact(strings.TrimSpace(raw)); d != "" {
		return d
	}
	// A text layer that broke the date into runs: "05 Octob er 202 6",
	// "0 9 /09/2026", "14 / 10 / 2026". Without its spaces it still reads.
	return parseNoticeDateExact(strings.Join(strings.Fields(raw), ""))
}

func parseNoticeDateExact(s string) string {
	build := func(y, m, d int) string {
		if y < 100 {
			y += 2000
		}
		if m < 1 || m > 12 || d < 1 || d > 31 || y < 1990 || y > 2100 {
			return ""
		}
		t := time.Date(y, time.Month(m), d, 0, 0, 0, 0, time.UTC)
		if t.Day() != d {
			return ""
		}
		return t.Format("2006-01-02")
	}
	month := func(w string) int {
		w = strings.ToLower(w)
		if mo, ok := monthIndex[w]; ok {
			return int(mo)
		}
		if len(w) >= 3 {
			if mo, ok := monthIndex[w[:3]]; ok && strings.HasPrefix(strings.ToLower(mo.String()), w) {
				return int(mo)
			}
		}
		return 0
	}
	if m := dmyNumRe.FindStringSubmatch(s); m != nil {
		d, _ := strconv.Atoi(m[1])
		mo, _ := strconv.Atoi(m[2])
		y, _ := strconv.Atoi(m[3])
		return build(y, mo, d)
	}
	if m := dmyWordRe.FindStringSubmatch(s); m != nil {
		d, _ := strconv.Atoi(m[1])
		y, _ := strconv.Atoi(m[3])
		return build(y, month(m[2]), d)
	}
	if m := mdyWordRe.FindStringSubmatch(s); m != nil {
		d, _ := strconv.Atoi(m[2])
		y, _ := strconv.Atoi(m[3])
		return build(y, month(m[1]), d)
	}
	return ""
}

// pctToken is one voting-power percentage and the votes figure written
// immediately before it, if any.
type pctToken struct {
	pct   float64
	votes *int64
}

// numberThenPctRe is a run of digits and commas ending in a percentage, with
// optional spaces before the % sign. The run carries the votes column too,
// either after a space or, in a plain text layer that glued the cells
// together, directly ("197,489,5146.12%").
var numberThenPctRe = regexp.MustCompile(`([0-9][0-9,]*(?:\s+[0-9][0-9,]*)?)\s*(?:\.\s*([0-9]+))?\s*%`)

// splitVotesAndPct splits a run like "197,489,5146.12" into votes 197,489,514
// and percentage 6.12. A comma-grouped integer ends after its last full group
// of three; whatever follows starts the next cell, and the last cell is the
// percentage. A text layer can glue several cells ("197,489,514197,489,5146.12":
// number of securities, votes, voting power), so the votes are the cell just
// before the percentage. A run with a space keeps the space as the boundary.
// Reports ok=false when the run cannot be split unambiguously.
func splitVotesAndPct(intPart, frac string) (votes *int64, pct float64, ok bool) {
	intPart = strings.TrimSpace(intPart)
	var votesStr, pctInt string
	if fields := strings.Fields(intPart); len(fields) == 2 {
		votesStr, pctInt = fields[0], fields[1]
		if strings.Contains(pctInt, ",") {
			return nil, 0, false
		}
	} else if strings.Contains(intPart, ",") {
		groups := strings.Split(intPart, ",")
		if len(groups[0]) == 0 || len(groups[0]) > 3 {
			return nil, 0, false
		}
		cur := groups[0]
		var cells []string
		for i := 1; i < len(groups); i++ {
			g := groups[i]
			switch {
			case len(g) == 3:
				cur += g
			case len(g) > 3:
				cells = append(cells, cur+g[:3])
				cur = g[3:]
				// A new cell's leading group is 1-3 digits; the last group's
				// remainder is the percentage, at most 3 digits.
				if len(cur) > 3 {
					return nil, 0, false
				}
				if i == len(groups)-1 {
					pctInt = cur
					cur = ""
				}
			default:
				return nil, 0, false
			}
		}
		if pctInt == "" || len(cells) == 0 {
			// "1,234,567%" names no percentage that is not also the votes.
			return nil, 0, false
		}
		votesStr = cells[len(cells)-1]
	} else {
		pctInt = intPart
	}
	if strings.Contains(pctInt, ",") || len(pctInt) > 3 {
		return nil, 0, false
	}
	pctStr := pctInt
	if frac != "" {
		pctStr += "." + frac
	}
	p, err := strconv.ParseFloat(pctStr, 64)
	if err != nil || p < 0 || p > 100 {
		return nil, 0, false
	}
	if votesStr != "" {
		v, err := strconv.ParseInt(strings.ReplaceAll(votesStr, ",", ""), 10, 64)
		if err != nil {
			return nil, 0, false
		}
		votes = &v
	}
	return votes, p, true
}

// votingPowerTokens returns, in document order, the percentages in s that
// sit in a votes column: each must follow a votes figure. A bare percentage
// in prose ("voting power of over 20% in Morgan Stanley") has none, so it is
// never a voting power.
func votingPowerTokens(s string) []pctToken {
	var out []pctToken
	for _, m := range numberThenPctRe.FindAllStringSubmatchIndex(s, -1) {
		intPart := s[m[2]:m[3]]
		frac := ""
		if m[4] >= 0 {
			frac = s[m[4]:m[5]]
		}
		votes, p, ok := splitVotesAndPct(intPart, frac)
		if !ok || votes == nil {
			continue
		}
		// A votes cell is a holding of at least 5% of a company: under a
		// thousand it is a stray fragment (a footnote marker, half a wrapped
		// cell), so the percentage stands in its column but the figure is
		// not kept.
		if *votes < 1000 {
			votes = nil
		}
		out = append(out, pctToken{pct: p, votes: votes})
	}
	return out
}

// sectionSpan returns the text between the first start match and the first
// end match after it, or "" when start is absent. Without an end it runs
// limit bytes.
func sectionSpan(s string, start, end *regexp.Regexp, limit int) string {
	loc := start.FindStringIndex(s)
	if loc == nil {
		return ""
	}
	rest := s[loc[1]:]
	if e := end.FindStringIndex(rest); e != nil {
		return rest[:e[0]]
	}
	if len(rest) > limit {
		return rest[:limit]
	}
	return rest
}

var (
	votingStartRe = looseRe(`(?i)%s|%s`, "details of voting power", "previous and present voting power")
	votingEndRe   = looseRe(`(?i)(?:\b3\s*\.\s*)?(?:%s|%s)`, "details of relevant interests", "changes in relevant interests")
	section1Re    = looseRe(`(?i)%s|%s`, "details of substantial holder", "details of substantial shareholder")
	section2Re    = looseRe(`(?i)\b2\s*\.\s*(?:%s|%s|%s)`, "details of voting power", "previous and present voting power", "changes in relevant interests")
	nzThisRe      = regexp.MustCompile(`(?i)For this disclosure,?\s*-?\s*\(a\)\s*total number held in class\s*:?\s*([0-9,]+)\s*\(b\)\s*total in class\s*:?\s*([0-9,]+)\s*\(c\)\s*total percentage held in class\s*:?\s*([0-9]+(?:\.[0-9]+)?)\s*%`)
	nzLastRe      = regexp.MustCompile(`(?i)For last disclosure,?\s*-?\s*\(a\)\s*total number held in class\s*:?\s*([0-9,]+)\s*\(b\)\s*total in class\s*:?\s*([0-9,]+)\s*\(c\)\s*total percentage held in class\s*:?\s*([0-9]+(?:\.[0-9]+)?)\s*%`)
)

// minNoticeText is the least text a notice with a text layer has: a scan's
// only text is the ASX watermark, which normalisation removes.
const minNoticeText = 200

// parseSubstantialNotice reads one notice's text. headline is ASX's title,
// used only when the document's own form title is not in its text layer.
func parseSubstantialNotice(text, headline string) (Notice, Outcome, string) {
	s := normalizeNoticeText(text)
	if len(s) < minNoticeText {
		return Notice{}, outcomeNoText, "no text layer (" + strconv.Itoa(len(s)) + " chars)"
	}
	form := formFromText(s)
	if form == "" {
		form = formFromHeadline(headline)
		lower := strings.ToLower(s)
		if form == "" || !(strings.Contains(lower, "substantial holder") || strings.Contains(lower, "substantial shareholder")) ||
			!strings.Contains(lower, "voting") {
			return Notice{}, outcomeNotNotice, "no substantial holding form in the document"
		}
	}
	n := Notice{Form: form}
	if form == FormNZ {
		return parseNZNotice(s, n)
	}
	if m := holderNameRe.FindStringSubmatch(s); m != nil {
		n.HolderName = cleanHolderName(m[1])
	}
	if m := companyNameRe.FindStringSubmatch(s); m != nil {
		n.CompanyName = strings.Trim(strings.TrimSpace(splitCapRe.ReplaceAllString(m[1], "$1$2")), ` :;,."'`)
	}
	for _, re := range eventDateRes {
		if m := re.FindStringSubmatch(s); m != nil {
			if d := parseNoticeDate(m[1]); d != "" {
				n.EventDate = d
				break
			}
		}
	}

	span := sectionSpan(s, votingStartRe, votingEndRe, 2500)
	tokens := votingPowerTokens(span)
	if len(tokens) == 0 {
		// A plain text layer can draw a form's values after every label:
		// read the whole form part, where a votes-then-percentage pair is
		// still the votes column.
		head := s
		if len(head) > 12000 {
			head = head[:12000]
		}
		tokens = votingPowerTokens(head)
	}

	switch form {
	case Form603:
		if len(tokens) == 0 {
			return n, outcomeNoVotingPower, "no votes and voting power pair"
		}
		best := tokens[0]
		for _, t := range tokens[1:] {
			if t.pct > best.pct {
				best = t
			}
		}
		// Becoming substantial is reaching 5%. Rounding writes 4.995% as 5.00%,
		// never as 4.9%.
		if best.pct < 4.95 {
			return n, outcomeImplausible, "initial notice under 5%: " + strconv.FormatFloat(best.pct, 'f', -1, 64)
		}
		n.PresentPct, n.PresentVotes = new(best.pct), best.votes
	case Form604:
		if len(tokens) < 2 {
			return n, outcomeNoVotingPower, "change notice without a previous and present pair"
		}
		if len(tokens)%2 != 0 {
			return n, outcomeNoVotingPower, "change notice with an odd number of voting power figures: " + strconv.Itoa(len(tokens))
		}
		// Rows are (previous, present) pairs, one per class; a total row is
		// the largest. The pair with the largest present figure is the
		// holder's ordinary voting power.
		bi := 0
		for i := 0; i < len(tokens); i += 2 {
			if tokens[i+1].pct > tokens[bi+1].pct {
				bi = i
			}
		}
		prev, cur := tokens[bi], tokens[bi+1]
		// The previous notice was a substantial holding notice, so it was at
		// least 5%; figures under that are some other table's.
		if prev.pct < 4.95 {
			return n, outcomeImplausible, "change notice whose previous voting power is under 5%: " + strconv.FormatFloat(prev.pct, 'f', -1, 64)
		}
		n.PreviousPct, n.PreviousVotes = new(prev.pct), prev.votes
		n.PresentPct, n.PresentVotes = new(cur.pct), cur.votes
		// A holder who fell below 5% gives a 605; one who used a 604 to say
		// so has still ceased to be substantial.
		if cur.pct < 4.95 {
			n.Ceased = true
		}
	case Form605:
		n.Ceased = true
		// A 605's figures, when it gives any, are the changes' votes, not a
		// holding: nothing is read from them.
	}
	return n, outcomeParsed, ""
}

// section1Text is section 1 of an Australian form (the holder's details),
// for a notice whose name label could not be paired with its value.
func section1Text(text string) string {
	return sectionSpan(normalizeNoticeText(text), section1Re, section2Re, 600)
}

func parseNZNotice(s string, n Notice) (Notice, Outcome, string) {
	if m := nzHolderNameRe.FindStringSubmatch(s); m != nil {
		n.HolderName = cleanHolderName(m[1])
	}
	if m := nzCompanyRe.FindStringSubmatch(s); m != nil {
		n.CompanyName = strings.TrimSpace(m[1])
	}
	if m := nzEventDateRe.FindStringSubmatch(s); m != nil {
		n.EventDate = parseNoticeDate(m[1])
	}
	ceasing := strings.Contains(strings.ToLower(s), "disclosure of ceasing to have substantial holding")
	read := func(m []string) (*int64, *float64) {
		if m == nil {
			return nil, nil
		}
		v, err := strconv.ParseInt(strings.ReplaceAll(m[1], ",", ""), 10, 64)
		if err != nil {
			return nil, nil
		}
		p, err := strconv.ParseFloat(m[3], 64)
		if err != nil || p < 0 || p > 100 {
			return nil, nil
		}
		return &v, &p
	}
	n.PresentVotes, n.PresentPct = read(nzThisRe.FindStringSubmatch(s))
	n.PreviousVotes, n.PreviousPct = read(nzLastRe.FindStringSubmatch(s))
	if ceasing || (n.PresentPct != nil && *n.PresentPct < 5) {
		n.Ceased = true
		return n, outcomeParsed, ""
	}
	if n.PresentPct == nil {
		return n, outcomeNoVotingPower, "NZ disclosure without a total percentage held"
	}
	return n, outcomeParsed, ""
}
