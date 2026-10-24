package alerts

import (
	"bytes"
	"fmt"
	"html/template"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/castlemilk/shorted.com.au/services/pkg/alertevents"
	"github.com/castlemilk/shorted.com.au/services/pkg/industry"
	"github.com/castlemilk/shorted.com.au/services/pkg/resend"
	"github.com/castlemilk/shorted.com.au/services/pkg/unsubscribe"
)

// The email is built from the event row, not from the monitor's current state, so
// a re-render of the same event produces the same bytes. Resend deduplicates a
// retry by Idempotency-Key only when the body matches, so this matters.

const (
	utmQuery = "utm_source=alerts&utm_medium=email"
	// emailTableRows is how many companies the email lists. The payload keeps more.
	emailTableRows = 25
	// canaryMonitorID names no real monitor. Its token pauses nothing.
	canaryMonitorID = "00000000-0000-0000-0000-000000000000"
	// footerContact is the sender's support address shown in the footer.
	footerContact = "support@shorted.com.au"
)

// Message is one alert, as the event row records it.
type Message struct {
	Scope      string
	Target     string
	Condition  string
	Cadence    string
	Threshold  *float64
	ReportDate Date
	ComparedTo Date
	Latest     *float64 // stock scope only
	Previous   *float64 // stock scope only
	Payload    alertevents.Payload
}

// rendered is one email in the shape Resend takes it, before the addresses.
type rendered struct {
	Subject string
	Text    string
	HTML    string
	Headers map[string]string
	Tags    []resend.Tag
}

// messageOf turns an evaluated candidate into the Message the email is built from.
func messageOf(c Candidate) Message {
	return Message{
		Scope:      c.Monitor.Scope,
		Target:     c.Monitor.Target,
		Condition:  c.Monitor.Condition,
		Cadence:    c.Monitor.Cadence,
		Threshold:  c.Monitor.Threshold,
		ReportDate: c.ReportDate,
		ComparedTo: c.ComparedTo,
		Latest:     c.Latest,
		Previous:   c.Previous,
		Payload:    c.Payload,
	}
}

// canaryMessage is the fixed stock-above fixture the daily canary sends through
// the same template. It is a test ticker, so no recipient reads it as a real alert.
func canaryMessage() Message {
	prev, latest, change, thr := 4.80, 5.42, 0.62, 5.0
	return Message{
		Scope:      alertevents.ScopeStock,
		Target:     "TEST",
		Condition:  alertevents.ConditionShortInterestAbove,
		Cadence:    alertevents.CadenceDaily,
		Threshold:  &thr,
		ReportDate: "2026-01-02",
		ComparedTo: "2026-01-01",
		Latest:     &latest,
		Previous:   &prev,
		Payload: alertevents.Payload{
			Companies: []alertevents.Company{{
				Code: "TEST", Name: "Canary delivery check", Latest: latest, Previous: &prev, Change: &change,
			}},
			CompaniesTotal: 1,
		},
	}
}

// renderMessage builds the subject, both bodies and the headers for one alert.
// site is the public origin, secret is UNSUBSCRIBE_SECRET, and monitorID is the
// monitor whose one-click pause link goes in the email.
func renderMessage(site, secret, monitorID string, m Message) (rendered, error) {
	site = strings.TrimRight(site, "/")
	token := unsubscribe.AlertMonitorToken(monitorID, secret)
	pauseURL := site + "/alerts/unsubscribe?t=" + token
	oneClickURL := site + "/api/alerts/unsubscribe?t=" + token
	manageURL := site + "/alerts"
	summary := summaryLine(m)
	subject := subjectLine(m)
	intro := introLine(m)

	headers, rows, more := tableOf(m)
	moreURL := industryURL(site, m)
	viewURL, viewLabel := "", ""
	if m.Scope == alertevents.ScopeStock {
		viewURL = site + "/shorts/" + m.Target + "?" + utmQuery
		viewLabel = "View " + m.Target + " on Shorted"
	}

	var text bytes.Buffer
	text.WriteString(subject + "\n\n")
	text.WriteString(intro + "\n")
	text.WriteString("ASIC publishes positions four trading days after they are held.\n\n")
	text.WriteString(textRow(headers, textWidths(m)) + "\n")
	for _, r := range rows {
		text.WriteString(textRow(r, textWidths(m)) + "\n")
	}
	if more > 0 {
		fmt.Fprintf(&text, "… and %d more: %s\n", more, moreURL)
	}
	if viewURL != "" {
		fmt.Fprintf(&text, "\n%s: %s\n", viewLabel, viewURL)
	}
	text.WriteString("--\n")
	fmt.Fprintf(&text, "You set up this alert on Shorted: %s.\n", summary)
	fmt.Fprintf(&text, "Pause this alert: %s\n", pauseURL)
	fmt.Fprintf(&text, "Manage your alerts: %s\n", manageURL)
	fmt.Fprintf(&text, "General information only, not financial advice. Shorted · %s\n", footerContact)

	var htmlBody bytes.Buffer
	data := htmlData{
		Headline:  subject,
		Intro:     intro,
		Headers:   headers,
		Rows:      rows,
		MoreCount: more,
		MoreURL:   moreURL,
		ViewURL:   viewURL,
		ViewLabel: viewLabel,
		Summary:   summary,
		PauseURL:  pauseURL,
		ManageURL: manageURL,
		Footer:    footerContact,
	}
	if err := alertTemplate.Execute(&htmlBody, data); err != nil {
		return rendered{}, fmt.Errorf("render alert html: %w", err)
	}

	return rendered{
		Subject: subject,
		Text:    text.String(),
		HTML:    htmlBody.String(),
		Headers: map[string]string{
			"List-Unsubscribe":      "<" + oneClickURL + ">",
			"List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
		},
		Tags: []resend.Tag{
			{Name: "category", Value: "alert"},
			{Name: "cadence", Value: m.Cadence},
		},
	}, nil
}

// subjectLine is the email subject. Weekly alerts are prefixed "Weekly: ". Figures
// use two decimal places and changes are signed in points.
func subjectLine(m Message) string {
	var body string
	n := m.Payload.CompaniesTotal
	switch m.Scope {
	case alertevents.ScopeStock:
		switch m.Condition {
		case alertevents.ConditionShortInterestAbove:
			body = fmt.Sprintf("%s short interest crossed %s%% (now %.2f%%)", m.Target, numStr(*m.Threshold), *m.Latest)
		case alertevents.ConditionShortInterestRises:
			body = fmt.Sprintf("%s short interest up %.2f pts to %.2f%%", m.Target, *m.Latest-*m.Previous, *m.Latest)
		}
	case alertevents.ScopeIndustry:
		switch m.Condition {
		case alertevents.ConditionShortInterestAbove:
			if n == 1 {
				body = fmt.Sprintf("%s: %s crossed %s%% short interest", m.Target, firstCode(m), numStr(*m.Threshold))
			} else {
				body = fmt.Sprintf("%s: %d companies crossed %s%% short interest", m.Target, n, numStr(*m.Threshold))
			}
		case alertevents.ConditionShortInterestRises:
			if n == 1 {
				body = fmt.Sprintf("%s: %s short interest rose %s+ pts", m.Target, firstCode(m), numStr(*m.Threshold))
			} else {
				body = fmt.Sprintf("%s: %d companies' short interest rose %s+ pts", m.Target, n, numStr(*m.Threshold))
			}
		case alertevents.ConditionNewTopTenEntry:
			if n >= 1 && n <= 3 {
				body = fmt.Sprintf("%s: %s entered the top 10 most shorted", m.Target, joinCodes(m))
			} else {
				body = fmt.Sprintf("%s: %d companies entered the top 10 most shorted", m.Target, n)
			}
		}
	}
	if m.Cadence == alertevents.CadenceWeekly {
		return "Weekly: " + body
	}
	return body
}

// summaryLine mirrors buildDraftSummary in web/src/app/alerts/alerts-content.tsx:
// "BHP - short interest above 5% - daily".
func summaryLine(m Message) string {
	switch m.Condition {
	case alertevents.ConditionShortInterestAbove:
		return fmt.Sprintf("%s - short interest above %s%% - %s", m.Target, numStr(*m.Threshold), m.Cadence)
	case alertevents.ConditionShortInterestRises:
		return fmt.Sprintf("%s - short interest rises by %s pts - %s", m.Target, numStr(*m.Threshold), m.Cadence)
	default:
		return fmt.Sprintf("%s - new top-ten entry - %s", m.Target, m.Cadence)
	}
}

// introLine says which two reports were compared.
func introLine(m Message) string {
	if m.Cadence == alertevents.CadenceWeekly {
		return fmt.Sprintf("Weekly comparison: the ASIC short position report for %s, compared with the previous week's report for %s.",
			fmtDay(m.ReportDate), fmtDay(m.ComparedTo))
	}
	return fmt.Sprintf("ASIC short position report for %s, compared with %s.", fmtDay(m.ReportDate), fmtDay(m.ComparedTo))
}

// fmtDay formats a report date as "Fri 16 Oct 2026".
func fmtDay(d Date) string {
	t, err := d.Day()
	if err != nil {
		return string(d)
	}
	return t.Format("Mon 2 Jan 2006")
}

// industryURL is the industry page an industry alert links to. A stock alert links
// to the stock, so its URL is empty.
func industryURL(site string, m Message) string {
	if m.Scope != alertevents.ScopeIndustry {
		return ""
	}
	return site + "/industry/" + industry.Slug(m.Target) + "?" + utmQuery
}

// tableOf returns the table's headers, the rows the email shows, and how many
// further companies it leaves out.
func tableOf(m Message) (headers []string, rows [][]string, more int) {
	cs := m.Payload.Companies
	if m.Condition == alertevents.ConditionNewTopTenEntry {
		headers = []string{"Code", "Company", "Rank before", "Rank now", "Latest"}
		for _, c := range cs {
			rows = append(rows, []string{c.Code, c.Name, rankOf(c.PreviousRank), rankOf(c.Rank), pct(&c.Latest)})
		}
	} else {
		headers = []string{"Code", "Company", "Previous", "Latest", "Change"}
		for _, c := range cs {
			latest := c.Latest
			rows = append(rows, []string{c.Code, c.Name, pct(c.Previous), pct(&latest), signed(c.Change)})
		}
	}
	if len(rows) > emailTableRows {
		more = len(rows) - emailTableRows
		rows = rows[:emailTableRows]
	}
	// The payload's total can exceed the stored companies.
	if extra := m.Payload.CompaniesTotal - len(m.Payload.Companies); extra > 0 {
		more += extra
	}
	return headers, rows, more
}

// textWidths sizes the plain-text table columns. Numeric columns sit to the right.
func textWidths(m Message) []int {
	if m.Condition == alertevents.ConditionNewTopTenEntry {
		return []int{6, 24, 11, 9, 8}
	}
	return []int{6, 24, 9, 8, 8}
}

// textRow lays one row out in fixed columns: code and name left, figures right.
func textRow(cells []string, widths []int) string {
	var b strings.Builder
	for i, cell := range cells {
		if i > 0 {
			b.WriteString("  ")
		}
		w := 0
		if i < len(widths) {
			w = widths[i]
		}
		if i == 1 {
			cell = truncateRunes(cell, w)
		}
		pad := w - utf8.RuneCountInString(cell)
		if i <= 1 {
			b.WriteString(cell)
			if pad > 0 {
				b.WriteString(strings.Repeat(" ", pad))
			}
		} else {
			if pad > 0 {
				b.WriteString(strings.Repeat(" ", pad))
			}
			b.WriteString(cell)
		}
	}
	return b.String()
}

func truncateRunes(s string, n int) string {
	if n <= 0 || utf8.RuneCountInString(s) <= n {
		return s
	}
	return string([]rune(s)[:n])
}

// pct formats a percentage to two places, or "-" when there is no reading.
func pct(v *float64) string {
	if v == nil {
		return "-"
	}
	return fmt.Sprintf("%.2f%%", *v)
}

// signed formats a change with its sign, or "-" when there is none.
func signed(v *float64) string {
	if v == nil {
		return "-"
	}
	return fmt.Sprintf("%+.2f", *v)
}

// rankOf formats a top-ten rank, where 0 means not ranked.
func rankOf(r int) string {
	if r == 0 {
		return "not ranked"
	}
	return fmt.Sprintf("#%d", r)
}

// numStr formats a threshold without trailing zeros: 5 and 1.5, never 5.00.
func numStr(v float64) string {
	return strconv.FormatFloat(v, 'f', -1, 64)
}

func firstCode(m Message) string {
	if len(m.Payload.Companies) == 0 {
		return ""
	}
	return m.Payload.Companies[0].Code
}

// joinCodes names the entrants of a short top-ten event, in rank order.
func joinCodes(m Message) string {
	codes := make([]string, 0, len(m.Payload.Companies))
	for _, c := range m.Payload.Companies {
		codes = append(codes, c.Code)
	}
	return strings.Join(codes, ", ")
}

// htmlData is what the HTML twin renders. Every string is escaped by html/template,
// so a company name with "&" or "<" is shown as written.
type htmlData struct {
	Headline  string
	Intro     string
	Headers   []string
	Rows      [][]string
	MoreCount int
	MoreURL   string
	ViewURL   string
	ViewLabel string
	Summary   string
	PauseURL  string
	ManageURL string
	Footer    string
}

var alertTemplate = template.Must(template.New("alert").Parse(`<!doctype html>
<html><body style="margin:0;padding:16px;font-family:Arial,Helvetica,sans-serif;color:#111;background:#fff">
<h2 style="font-size:18px;margin:0 0 12px">{{.Headline}}</h2>
<p style="margin:0 0 4px">{{.Intro}}</p>
<p style="margin:0 0 16px;color:#555">ASIC publishes positions four trading days after they are held.</p>
<table style="border-collapse:collapse;width:100%;font-size:14px">
<thead><tr>{{range .Headers}}<th style="text-align:left;border-bottom:1px solid #ccc;padding:6px 8px">{{.}}</th>{{end}}</tr></thead>
<tbody>{{range .Rows}}<tr>{{range .}}<td style="padding:6px 8px;border-bottom:1px solid #eee">{{.}}</td>{{end}}</tr>{{end}}</tbody>
</table>
{{if .MoreCount}}<p style="margin:12px 0">… and {{.MoreCount}} more: <a href="{{.MoreURL}}">{{.MoreURL}}</a></p>{{end}}
{{if .ViewURL}}<p style="margin:12px 0"><a href="{{.ViewURL}}">{{.ViewLabel}}</a></p>{{end}}
<hr style="border:none;border-top:1px solid #eee;margin:20px 0">
<p style="margin:0 0 8px;color:#555;font-size:12px">You set up this alert on Shorted: {{.Summary}}.</p>
<p style="margin:0 0 8px;font-size:12px"><a href="{{.PauseURL}}">Pause this alert</a> · <a href="{{.ManageURL}}">Manage your alerts</a></p>
<p style="margin:0;color:#555;font-size:12px">General information only, not financial advice. Shorted · {{.Footer}}</p>
</body></html>`))
