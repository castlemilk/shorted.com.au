package ownership

import (
	"regexp"
	"strings"
	"unicode"
)

var (
	reformTransitionalTitle = regexp.MustCompile(`(?im)^[ \t]*transitional[ \t\r\n]+form[ \t\r\n]+6[ \t]*0[ \t]*([345])[ \t]*(?:\r?$|\|)`)
	reformSHNTitle          = regexp.MustCompile(`(?im)^[ \t]*substantial[ \t\r\n]+holding[ \t\r\n]+notice[ \t]*(?:\r?$|\|)`)
	reformSection           = regexp.MustCompile(`(?i)section\s*671\s*bb\b`)
)

// unsupportedNoticeFormat recognises reform layouts the legacy voting-only
// reader must withhold. It does not extract new measures or decide legal triggers.
// Keep this guard aligned with report-extractor/notice_format.py using the shared
// synthetic fixtures. Text-free scans and unrecognised custom/OCR layouts are
// outside this guard's coverage; the full reader transition remains #971.
func unsupportedNoticeFormat(text string) string {
	head := text
	if len(head) > 12000 {
		head = head[:12000]
	}
	head = strings.Map(func(r rune) rune {
		if r == '\f' {
			return '\n'
		}
		if unicode.Is(unicode.Zs, r) {
			return ' '
		}
		if r == '\ufeff' || r == '\u200b' {
			return -1
		}
		return r
	}, head)
	for _, loc := range reformTransitionalTitle.FindAllStringSubmatchIndex(head, -1) {
		if reformSection.MatchString(head[loc[1]:min(len(head), loc[1]+300)]) {
			return "transitional_60" + head[loc[2]:loc[3]]
		}
	}
	for _, loc := range reformSHNTitle.FindAllStringIndex(head, -1) {
		// Mixed full-format packets are withheld; this reader cannot choose
		// which notice is current. Prose-only references do not match.
		body := strings.ToLower(strings.Join(strings.Fields(strings.ReplaceAll(head[loc[1]:], "|", " ")), " "))
		holding := strings.Contains(body, "holding percentage")
		reason := strings.Contains(body, "reason for notice")
		derivative := strings.Contains(body, "previous and present derivative-based percentages")
		if reformSection.MatchString(head[loc[1]:min(len(head), loc[1]+300)]) && holding && (reason || derivative) {
			return "shn"
		}
	}
	return ""
}
