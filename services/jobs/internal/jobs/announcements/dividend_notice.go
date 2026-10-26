package announcements

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Precompiled regexes for value patterns
var (
	datePat         = regexp.MustCompile(`^(\d{1,2})/(\d{1,2})/(\d{4})$`)
	moneyPat        = regexp.MustCompile(`^([A-Z]{3}) (\d+(?:\.\d+)?)$`)
	percentPat      = regexp.MustCompile(`^(\d+(?:\.\d+)?) ?%$`)
	codePat         = regexp.MustCompile(`^[A-Z0-9]{3,6}$`)
	currencyLinePat = regexp.MustCompile(`^([A-Z]{3}) - `)
	labelPat        = regexp.MustCompile(`^(\d[A-Z]?\.\d+[a-z]?(\([ivx]+\))?)\s`)

	// Some notices' text layer runs a field's label, its value, its answer and
	// the next label together on one line (Storage King's: "...will be
	// announced14/8/20263A.1b Ordinary Dividend/distribution amount per
	// securityAUD 0.031000003A.2 Is the ordinary dividend/distribution
	// franked?Yes"). unglue splits them where two tokens touch: before a field
	// label, an amount or a date that follows text, before "Estimated or
	// Actual?" after an amount, and after a question's mark. A well-formed line
	// has a space or a line break at each of those places, so it is unchanged.
	gluedLabelPat    = regexp.MustCompile(`(\S)(\d[A-Z]\.\d+[a-z]?(?:\([ivx]+\))?\s)`)
	gluedMoneyPat    = regexp.MustCompile(`([a-z?)])([A-Z]{3} \d+\.\d+)`)
	gluedDatePat     = regexp.MustCompile(`([a-z])(\d{1,2}/\d{1,2}/\d{4})`)
	gluedQuestionPat = regexp.MustCompile(`(\d)(Estimated or Actual\?)`)
	gluedAnswerPat   = regexp.MustCompile(`\?(Yes|No|Actual|Estimated)\b`)
)

// unglue splits a line whose fields the text layer ran together (see
// gluedLabelPat) into the lines a well-formed notice has.
func unglue(line string) []string {
	line = gluedLabelPat.ReplaceAllString(line, "$1\n$2")
	line = gluedMoneyPat.ReplaceAllString(line, "$1\n$2")
	line = gluedDatePat.ReplaceAllString(line, "$1\n$2")
	line = gluedQuestionPat.ReplaceAllString(line, "$1\n$2")
	line = gluedAnswerPat.ReplaceAllString(line, "?\n$1")
	return strings.Split(line, "\n")
}

// DividendNotice is what an ASX Appendix 3A.1 states, read from extracted PDF text.
type DividendNotice struct {
	SecurityCode     string   // 1.6 ASX +Security Code, e.g. "CBA", "CBAPI"
	AnnouncementType string   // "new", "update" or "cancellation"
	AnnouncedOn      string   // YYYY-MM-DD (1.5, else the summary's "Date of this announcement")
	PeriodEnd        string   // YYYY-MM-DD (2A.3); "" when absent
	RecordDate       string   // YYYY-MM-DD (2A.4, else summary); "" when absent
	ExDate           string   // YYYY-MM-DD (2A.5, else summary); required
	PaymentDate      string   // YYYY-MM-DD (2A.6, else summary); "" when absent
	Currency         string   // ISO code of the primary currency (2A.8, e.g. "AUD - Australian Dollar" -> "AUD")
	Total            float64  // 2A.9 (else summary "Distribution Amount"), in Currency
	AUDEquivalent    *float64 // 2A.9a when Currency != "AUD" and an amount is stated; nil otherwise
	Supplementary    float64  // 3F.2b (else the estimate 3F.2a), in Currency; an NZD-declared supplementary dividend paid only to non-NZ-resident holders; never a stored dividend, and Total includes it or not as the issuer chose (MCY includes it, AFP does not)
	Scrip            float64  // 3C.1b (else the estimate 3C.1a), in Currency: a distribution paid in securities (BCN's Forrestania shares in specie); it counts toward Total but is never a stored dividend
	AUDEquivalentDue string   // YYYY-MM-DD (2A.9b): when a foreign notice's AUD equivalent will be released; "" when absent
	ActualDue        string   // YYYY-MM-DD (3A.1a(i), else 3B.1a(i)): when an estimated amount's actual will be announced; "" when absent
	Parts            []DividendPart
}

// DividendPart is one type of dividend the notice declares.
type DividendPart struct {
	Type       string   // "ordinary" (Part 3A) or "special" (Part 3B)
	Amount     float64  // 3A.1b / 3B.1b; when absent, the estimate 3A.1a / 3B.1a
	Estimated  bool     // true when Amount came from 3A.1a / 3B.1a
	FrankedPct *float64 // 3A.3 / 3B.3 (percent, 0-100); else 100 minus 3A.5 / 3B.5 (unfranked percent); nil when neither is stated
}

type noticeOutcome string

const (
	noticeParsed       noticeOutcome = "parsed"
	noticeNotForm      noticeOutcome = "not_appendix_3a1"
	noticeCancellation noticeOutcome = "cancellation"
	noticeMissingField noticeOutcome = "missing_field"
	noticeInconsistent noticeOutcome = "inconsistent"
	noticeNoAmount     noticeOutcome = "no_amount"
	// noticeScripOnly: the notice pays only in securities (Part 3C), so it
	// declares no cash dividend to store. Final, like a cancellation.
	noticeScripOnly noticeOutcome = "scrip_only"
)

// parseDividendNotice reads one notice. On any outcome other than noticeParsed the
// notice is not usable and detail says why (for logs), e.g. "ex date" or
// "parts sum 0.72 != total 0.62".
func parseDividendNotice(text string) (DividendNotice, noticeOutcome, string) {
	// Check for the form marker
	if !strings.Contains(text, "Appendix 3A.1 - Notification of dividend / distribution") {
		return DividendNotice{}, noticeNotForm, ""
	}

	// Normalize: split on newline (and where fields run together), trim, drop
	// empty lines, drop header and "For personal use only"
	var normalized []string
	for raw := range strings.SplitSeq(text, "\n") {
		for _, line := range unglue(strings.TrimSpace(raw)) {
			line = strings.TrimSpace(line)
			if line == "" {
				continue
			}
			if line == "Appendix 3A.1 - Notification of dividend / distribution" {
				continue
			}
			if line == "For personal use only" {
				continue
			}
			normalized = append(normalized, line)
		}
	}

	// Parse summary block to get initial values
	summary := extractSummary(normalized)

	notice := DividendNotice{}

	// Get announcement type
	announcementType := summary["Announcement Type"]
	if strings.Contains(announcementType, "Cancel") {
		return DividendNotice{SecurityCode: readSecurityCode(normalized, summary), AnnouncementType: "cancellation"}, noticeCancellation, ""
	}

	if strings.HasPrefix(announcementType, "New") {
		notice.AnnouncementType = "new"
	} else if strings.HasPrefix(announcementType, "Update") {
		notice.AnnouncementType = "update"
	} else if hasField(normalized, "1.4a") {
		notice.AnnouncementType = "update"
	} else {
		notice.AnnouncementType = "new"
	}

	secCode := readSecurityCode(normalized, summary)
	if secCode == "" {
		return notice, noticeMissingField, "security code"
	}
	notice.SecurityCode = secCode

	// Announced on: field 1.5; else summary
	announcedOn := readField(normalized, "1.5", datePat)
	if announcedOn == "" {
		announcedOn = summary["Date of this announcement"]
	}
	if announcedOn != "" {
		announcedOn = parseDate(announcedOn)
	}
	notice.AnnouncedOn = announcedOn

	// Period end: field 2A.3
	periodEnd := readField(normalized, "2A.3", datePat)
	if periodEnd != "" {
		periodEnd = parseDate(periodEnd)
	}
	notice.PeriodEnd = periodEnd

	// Record date: field 2A.4; else summary
	recordDate := readField(normalized, "2A.4", datePat)
	if recordDate == "" {
		recordDate = summary["Record Date"]
	}
	if recordDate != "" {
		recordDate = parseDate(recordDate)
	}
	notice.RecordDate = recordDate

	// Ex date: field 2A.5; else summary; REQUIRED
	exDate := readField(normalized, "2A.5", datePat)
	if exDate == "" {
		exDate = summary["Ex Date"]
	}
	if exDate == "" {
		return notice, noticeMissingField, "ex date"
	}
	exDate = parseDate(exDate)
	notice.ExDate = exDate

	// Payment date: field 2A.6; else summary
	paymentDate := readField(normalized, "2A.6", datePat)
	if paymentDate == "" {
		paymentDate = summary["Payment Date"]
	}
	if paymentDate != "" {
		paymentDate = parseDate(paymentDate)
	}
	notice.PaymentDate = paymentDate

	// Currency: field 2A.8 (extract ISO code); else from 2A.9 money value
	currencyLine := readField(normalized, "2A.8", currencyLinePat)
	var currencyCode string
	if currencyLine != "" {
		currencyCode = extractCurrencyCode(currencyLine)
	}
	if currencyCode == "" {
		// Try to extract from 2A.9
		totalLine := readField(normalized, "2A.9", moneyPat)
		if totalLine != "" {
			currencyCode = extractCurrencyFromMoney(totalLine)
		}
	}
	if currencyCode == "" {
		// Try from summary Distribution Amount
		distAmount := summary["Distribution Amount"]
		if distAmount != "" {
			currencyCode = extractCurrencyFromMoney(distAmount)
		}
	}
	if currencyCode == "" {
		return notice, noticeMissingField, "currency"
	}
	notice.Currency = currencyCode

	// Total: field 2A.9; else summary "Distribution Amount"; REQUIRED
	totalStr := readField(normalized, "2A.9", moneyPat)
	if totalStr == "" {
		totalStr = summary["Distribution Amount"]
	}
	total, ok := parseMoneyValue(totalStr, currencyCode)
	if !ok || total == 0 {
		return notice, noticeMissingField, "total"
	}
	notice.Total = total

	// AUD equivalent: field 2A.9a, only if Currency != "AUD" and amount is stated
	if currencyCode != "AUD" {
		audEquivStr := readField(normalized, "2A.9a", moneyPat)
		if audEquivStr != "" {
			if audEquiv, ok := parseMoneyValue(audEquivStr, "AUD"); ok && audEquiv > 0 {
				notice.AUDEquivalent = &audEquiv
			}
		}
	}

	// The dates a notice that cannot be stored yet promises its update by:
	// 2A.9b for the AUD equivalent, 3A.1a(i) / 3B.1a(i) for an estimate's
	// actual amount.
	notice.AUDEquivalentDue = parseDate(readField(normalized, "2A.9b", datePat))
	notice.ActualDue = parseDate(readField(normalized, "3A.1a(i)", datePat))
	if notice.ActualDue == "" {
		notice.ActualDue = parseDate(readField(normalized, "3B.1a(i)", datePat))
	}

	// Supplementary dividend: field 3F.2b (else the estimate 3F.2a)
	supplementaryStr := readField(normalized, "3F.2b", moneyPat)
	if supplementaryStr == "" {
		supplementaryStr = readField(normalized, "3F.2a", moneyPat)
	}
	if supplementaryStr != "" {
		if supplementary, ok := parseMoneyValue(supplementaryStr, currencyCode); ok && supplementary > 0 {
			notice.Supplementary = supplementary
		}
	}

	// Scrip dividend: field 3C.1b (else the estimate 3C.1a), paid in securities
	scripStr := readField(normalized, "3C.1b", moneyPat)
	if scripStr == "" {
		scripStr = readField(normalized, "3C.1a", moneyPat)
	}
	if scripStr != "" {
		if scrip, ok := parseMoneyValue(scripStr, currencyCode); ok && scrip > 0 {
			notice.Scrip = scrip
		}
	}

	// Parse parts: ordinary from 3A.1b, else 3A.1a; special from 3B.1b, else 3B.1a
	actual := estimatesAreActual(normalized)
	ordinaries := parseParts(normalized, "3A", currencyCode, actual)
	specials := parseParts(normalized, "3B", currencyCode, actual)

	if len(ordinaries) == 0 && len(specials) == 0 && notice.Scrip == 0 {
		return notice, noticeNoAmount, ""
	}

	notice.Parts = append(notice.Parts, ordinaries...)
	notice.Parts = append(notice.Parts, specials...)

	// Parts are already validated for currency consistency in parseParts()

	// Validate: the parts and any scrip sum to Total within tolerance. Total
	// includes an NZ supplementary or not, as the issuer chose: MCY's 0.20 is
	// its 0.17 and its 0.03 supplementary, AFP's 0.025 leaves its 0.00441176 out.
	sum := notice.Scrip
	for _, part := range notice.Parts {
		sum += part.Amount
	}
	const epsilon = 1e-6
	if absDiff(sum, notice.Total) > epsilon && absDiff(sum+notice.Supplementary, notice.Total) > epsilon {
		msg := fmt.Sprintf("parts sum %.8g", sum-notice.Scrip)
		if notice.Scrip > epsilon {
			msg += fmt.Sprintf(" + scrip %.8g", notice.Scrip)
		}
		if notice.Supplementary > epsilon {
			msg += fmt.Sprintf(" + supplementary %.8g", notice.Supplementary)
		}
		return notice, noticeInconsistent, msg + fmt.Sprintf(" != total %.8g", notice.Total)
	}

	if len(notice.Parts) == 0 {
		return notice, noticeScripOnly, fmt.Sprintf("paid in securities: %s %.8g a security", notice.Currency, notice.Scrip)
	}
	return notice, noticeParsed, ""
}

// extractSummary finds the summary block and returns key-value pairs by looking for known labels
func extractSummary(lines []string) map[string]string {
	result := make(map[string]string)

	// Find summary block and extract specific labels
	summaryLabels := []string{
		"Entity name",
		"Security on which the Distribution will be paid",
		"Announcement Type",
		"Date of this announcement",
		"Distribution Amount",
		"Ex Date",
		"Record Date",
		"Payment Date",
		"Reason for the Update",
	}

	for _, label := range summaryLabels {
		value := findSummaryValue(lines, label)
		if value != "" {
			result[label] = value
		}
	}

	return result
}

// findSummaryValue searches for a label in the summary section and returns the next line as value
func findSummaryValue(lines []string, label string) string {
	inSummary := false

	for i, line := range lines {
		// Mark when we enter the summary block
		if strings.Contains(line, "Summary") && (strings.Contains(line, "Announcement") || strings.Contains(line, "Update")) {
			inSummary = true
			continue
		}

		// Exit when we reach the end of summary
		if inSummary && strings.Contains(line, "Refer to below for full details of the announcement") {
			return ""
		}

		// Look for the label
		if inSummary && strings.TrimSpace(line) == label {
			// Next line should be the value
			if i+1 < len(lines) {
				nextLine := strings.TrimSpace(lines[i+1])
				if nextLine != "" && nextLine != "Refer to below for full details of the announcement" {
					return nextLine
				}
			}
			return ""
		}
	}

	return ""
}

// extractSecurity Code extracts the code from a summary security line like "CBA - ORDINARY FULLY PAID"
func extractSecurityCode(summaryLine string) string {
	parts := strings.Split(summaryLine, " - ")
	if len(parts) > 0 {
		code := strings.TrimSpace(parts[0])
		if isValidSecurityCode(code) {
			return code
		}
	}
	return ""
}

// isValidSecurityCode checks if a string looks like an ASX security code
func isValidSecurityCode(code string) bool {
	return codePat.MatchString(code)
}

// readSecurityCode is field 1.6, else the code before " - " in the summary's
// "Security on which the Distribution will be paid", else the 1.3 issuer code
// when the notice is not for a preference security: LED's and Storage King's
// updates leave both blank. A notice with a Part 3D (a hybrid's, which may
// carry a Part 3A too, as CBAPI's does) never takes its issuer's code, or a
// hybrid's distribution would be stored as the issuer's ordinary dividend.
func readSecurityCode(lines []string, summary map[string]string) string {
	if code := readField(lines, "1.6", codePat); code != "" {
		return code
	}
	if code := extractSecurityCode(summary["Security on which the Distribution will be paid"]); code != "" {
		return code
	}
	for _, line := range lines {
		if strings.HasPrefix(line, "Part 3D") {
			return ""
		}
	}
	return readField(lines, "1.3", codePat)
}

// estimatesAreActual is whether the notice answers every "Estimated or
// Actual?" with "Actual". LED's finalising update restates its amount in the
// estimate field (3A.1a), leaves 3A.1b blank and answers only "Actual"; LRT's
// final update answers one of each, and its amount stays an estimate.
func estimatesAreActual(lines []string) bool {
	actual, estimated := 0, 0
	for _, line := range lines {
		switch line {
		case "Actual":
			actual++
		case "Estimated":
			estimated++
		}
	}
	return actual > 0 && estimated == 0
}

// readField reads the value of a specific field, returning only lines that match the expected pattern
func readField(lines []string, label string, want *regexp.Regexp) string {
	for i, line := range lines {
		trimmed := strings.TrimSpace(line)
		// Extract field label from this line
		m := labelPat.FindStringSubmatch(trimmed)
		if m == nil || m[1] != label {
			continue
		}

		// Found the label; scan following lines for a matching value
		for j := i + 1; j < len(lines); j++ {
			nextLine := strings.TrimSpace(lines[j])

			// Stop if we hit another label or Part line
			if labelPat.MatchString(nextLine) || strings.HasPrefix(nextLine, "Part ") {
				break
			}

			// Check if this line matches the expected pattern
			if nextLine != "" && want.MatchString(nextLine) {
				return nextLine
			}
		}
	}
	return ""
}

// hasField checks if a field label exists
func hasField(lines []string, fieldLabel string) bool {
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		m := labelPat.FindStringSubmatch(trimmed)
		if m != nil && m[1] == fieldLabel {
			return true
		}
	}
	return false
}

// extractCurrencyCode extracts ISO code from a line like "AUD - Australian Dollar"
func extractCurrencyCode(line string) string {
	m := currencyLinePat.FindStringSubmatch(line)
	if m != nil {
		return m[1]
	}
	return ""
}

// extractCurrencyFromMoney extracts currency from a money line like "AUD 2.70000000"
func extractCurrencyFromMoney(line string) string {
	m := moneyPat.FindStringSubmatch(line)
	if m != nil {
		return m[1]
	}
	return ""
}

// parseMoneyValue extracts the amount from a money line like "AUD 2.70000000"
// Returns 0 and false if currency doesn't match or no valid amount
func parseMoneyValue(line string, expectedCurrency string) (float64, bool) {
	if strings.TrimSpace(line) == expectedCurrency {
		// Empty money value (just the currency)
		return 0, false
	}

	m := moneyPat.FindStringSubmatch(line)
	if m != nil {
		if m[1] != expectedCurrency {
			return 0, false
		}
		amount, err := strconv.ParseFloat(m[2], 64)
		if err != nil {
			return 0, false
		}
		return amount, true
	}
	return 0, false
}

// parseDate converts DD/MM/YYYY to YYYY-MM-DD, returns "" if invalid
func parseDate(dateStr string) string {
	m := datePat.FindStringSubmatch(dateStr)
	if m == nil {
		return ""
	}

	day, _ := strconv.Atoi(m[1])
	month, _ := strconv.Atoi(m[2])
	year, _ := strconv.Atoi(m[3])

	// Validate date
	t := time.Date(year, time.Month(month), day, 0, 0, 0, 0, time.UTC)
	if t.Month() != time.Month(month) || t.Day() != day {
		return ""
	}
	return fmt.Sprintf("%04d-%02d-%02d", year, month, day)
}

// parseParts reads ordinary or special dividend parts. An amount read from the
// estimate field is an estimate unless estimatesActual (estimatesAreActual).
func parseParts(lines []string, partType string, expectedCurrency string, estimatesActual bool) []DividendPart {
	// partType is "3A" (ordinary) or "3B" (special)
	var result []DividendPart

	amountFieldActual := partType + ".1b"
	amountFieldEstimated := partType + ".1a"
	frankedField := partType + ".3"
	unfrankedField := partType + ".5"

	// Try actual amount first
	actualStr := readField(lines, amountFieldActual, moneyPat)
	estimatedStr := readField(lines, amountFieldEstimated, moneyPat)

	var amount float64
	var estimated bool

	if actualStr != "" {
		if amt, ok := parseMoneyValue(actualStr, expectedCurrency); ok && amt > 0 {
			amount = amt
			estimated = false
		}
	}

	if amount == 0 && estimatedStr != "" {
		if amt, ok := parseMoneyValue(estimatedStr, expectedCurrency); ok && amt > 0 {
			amount = amt
			estimated = !estimatesActual
		}
	}

	if amount == 0 {
		return result
	}

	// Determine franking percentage
	var frankedPct *float64

	// Try field 3A.3 / 3B.3 first
	frankedStr := readField(lines, frankedField, percentPat)
	if frankedStr != "" {
		if pct, ok := parsePercent(frankedStr); ok {
			frankedPct = &pct
		}
	}

	// If no franked percent, try to compute from unfranked percent (100 - unfranked)
	if frankedPct == nil {
		unfrankedStr := readField(lines, unfrankedField, percentPat)
		if unfrankedStr != "" {
			if pct, ok := parsePercent(unfrankedStr); ok {
				computed := 100.0 - pct
				frankedPct = &computed
			}
		}
	}

	partTypeStr := "ordinary"
	if partType == "3B" {
		partTypeStr = "special"
	}

	result = append(result, DividendPart{
		Type:       partTypeStr,
		Amount:     amount,
		Estimated:  estimated,
		FrankedPct: frankedPct,
	})

	return result
}

// parsePercent extracts a percentage from a line like "100.0000 %"
func parsePercent(line string) (float64, bool) {
	m := percentPat.FindStringSubmatch(line)
	if m != nil {
		pct, err := strconv.ParseFloat(m[1], 64)
		if err == nil {
			return pct, true
		}
	}
	return 0, false
}

// absDiff returns the absolute difference between two floats
func absDiff(a, b float64) float64 {
	if a > b {
		return a - b
	}
	return b - a
}
