package alerts

import (
	"bytes"
	"crypto/sha256"
	_ "embed"
	"encoding/base64"
	"fmt"
	"log"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/castlemilk/shorted.com.au/services/pkg/alertchart"
	"github.com/castlemilk/shorted.com.au/services/pkg/alertevents"
	"github.com/castlemilk/shorted.com.au/services/pkg/industry"
	"github.com/castlemilk/shorted.com.au/services/pkg/resend"
	"github.com/castlemilk/shorted.com.au/services/pkg/unsubscribe"
)

// The email is built from the event row, not from the monitor's current state, so
// a re-render of the same event produces the same bytes. Resend deduplicates a
// retry by Idempotency-Key only when the body matches, so this matters. The chart
// is drawn from the stored history with no clock or randomness, so it is stable
// too.

const (
	utmQuery = "utm_source=alerts&utm_medium=email"
	// emailTableRows is how many companies the email lists. The payload keeps more.
	emailTableRows = 25
	// canaryMonitorID names no real monitor. Its token pauses nothing.
	canaryMonitorID = "00000000-0000-0000-0000-000000000000"
	// footerContact is the sender's support address shown in the footer.
	footerContact = "support@shorted.com.au"

	// markCID and chartCID are the Content-IDs the HTML refers to as cid:.
	markCID      = "shorted-mark"
	chartCID     = "chart"
	chartDarkCID = "chart-dark"
)

// shortedMarkPNG is the brand mark the header shows, 76x64 (2x of 38x32), drawn
// from web/public/logo.png.
//
//go:embed assets/shorted-mark.png
var shortedMarkPNG []byte

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
	Subject     string
	Text        string
	HTML        string
	Headers     map[string]string
	Tags        []resend.Tag
	Attachments []resend.Attachment
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

// canaryMessage is the fixed stock-above fixture the canary sends through the same
// template, chart and attachments. It is a test ticker, so no recipient reads it as
// a real alert. Its history is generated from a fixed formula, never at random.
func canaryMessage() Message {
	prev, latest, change, thr := 4.80, 5.42, 0.62, 5.0
	const reportDate, comparedTo = "2026-01-02", "2026-01-01"
	history := canaryHistory(60, reportDate, latest)
	change20 := round2(latest - history[len(history)-21].P)
	change20Date := history[len(history)-21].D
	shortsOnIssue := 1.8e9
	shortsShort := 2.4e8
	return Message{
		Scope:      alertevents.ScopeStock,
		Target:     "TEST",
		Condition:  alertevents.ConditionShortInterestAbove,
		Cadence:    alertevents.CadenceDaily,
		Threshold:  &thr,
		ReportDate: reportDate,
		ComparedTo: comparedTo,
		Latest:     &latest,
		Previous:   &prev,
		Payload: alertevents.Payload{
			Companies: []alertevents.Company{{
				Code: "TEST", Name: "Canary delivery check", Latest: latest, Previous: &prev, Change: &change,
			}},
			CompaniesTotal: 1,
			Stock: &alertevents.StockDetail{
				Name:          "Canary delivery check",
				Industry:      "Testing",
				SharesShort:   &shortsShort,
				SharesOnIssue: &shortsOnIssue,
				Rank:          7,
				Ranked:        480,
				Change20:      &change20,
				Change20Date:  change20Date,
				History:       history,
			},
		},
	}
}

// canaryHistory returns n weekday readings ending on last, oldest first. They climb
// from 4.00 to end on the given latest value. Weekends are skipped, so the spacing
// matches report dates.
func canaryHistory(n int, last string, end float64) []alertevents.Point {
	day, _ := time.Parse(dateLayout, last)
	days := make([]time.Time, 0, n)
	for d := day; len(days) < n; d = d.AddDate(0, 0, -1) {
		if wd := d.Weekday(); wd == time.Saturday || wd == time.Sunday {
			continue
		}
		days = append(days, d)
	}
	out := make([]alertevents.Point, n)
	for i := range out {
		// days is newest first; i indexes from the oldest.
		d := days[n-1-i]
		v := 4.0 + (end-4.0)*float64(i)/float64(n-1)
		out[i] = alertevents.Point{D: d.Format(dateLayout), P: round2(v)}
	}
	return out
}

// renderMessage builds the subject, both bodies, the headers and the attachments
// for one alert. site is the public origin, secret is UNSUBSCRIBE_SECRET, and
// monitorID is the monitor whose one-click pause link goes in the email.
func renderMessage(site, secret, monitorID string, m Message) (rendered, error) {
	return renderMessageCharts(nil, site, secret, monitorID, m)
}

// renderMessageCharts is renderMessage with a chart memo. A delivery pass passes its
// memo, so owners of the same stock share one rendered chart. A nil memo renders
// every chart afresh. The bytes are the same either way: the memo is keyed by the
// whole chart spec.
func renderMessageCharts(charts *chartMemo, site, secret, monitorID string, m Message) (rendered, error) {
	site = strings.TrimRight(site, "/")
	token := unsubscribe.AlertMonitorToken(monitorID, secret)
	pauseURL := site + "/alerts/unsubscribe?t=" + token
	oneClickURL := site + "/api/alerts/unsubscribe?t=" + token
	manageURL := site + "/alerts"
	subject := subjectLine(m)

	headers, rows, more := tableOf(m)
	moreURL := industryURL(site, m)
	viewURL, viewLabel := "", ""
	if m.Scope == alertevents.ScopeStock {
		viewURL = site + "/shorts/" + m.Target + "?" + utmQuery
		viewLabel = "View " + m.Target + " on Shorted"
	} else {
		viewURL = moreURL
		viewLabel = "View " + m.Target + " on Shorted"
	}

	atts := []resend.Attachment{inline("shorted-mark.png", markCID, shortedMarkPNG)}
	light, dark := charts.get(m)
	if light != nil {
		atts = append(atts, inline("short-interest-chart.png", chartCID, light))
		atts = append(atts, inline("short-interest-chart-dark.png", chartDarkCID, dark))
	}

	htmlBody, err := renderHTML(htmlInput{
		msg:       m,
		subject:   subject,
		headers:   headers,
		rows:      rows,
		more:      more,
		moreURL:   moreURL,
		viewURL:   viewURL,
		viewLabel: viewLabel,
		summary:   summaryLine(m),
		pauseURL:  pauseURL,
		manageURL: manageURL,
		hasChart:  light != nil,
	})
	if err != nil {
		return rendered{}, fmt.Errorf("render alert html: %w", err)
	}

	return rendered{
		Subject: subject,
		Text:    plainText(m, plainInput{subject: subject, headers: headers, rows: rows, more: more, moreURL: moreURL, viewURL: viewURL, viewLabel: viewLabel, summary: summaryLine(m), pauseURL: pauseURL, manageURL: manageURL}),
		HTML:    htmlBody,
		Headers: map[string]string{
			"List-Unsubscribe":      "<" + oneClickURL + ">",
			"List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
		},
		Tags: []resend.Tag{
			{Name: "category", Value: "alert"},
			{Name: "cadence", Value: m.Cadence},
		},
		Attachments: atts,
	}, nil
}

// inline is a PNG attached for embedding: the HTML refers to it as cid:<id>.
func inline(filename, id string, data []byte) resend.Attachment {
	return resend.Attachment{
		Filename:    filename,
		Content:     base64.StdEncoding.EncodeToString(data),
		ContentType: "image/png",
		ContentID:   id,
	}
}

// testChartHook, when set, runs before each chart is drawn. Only tests set it: a
// panic injected here shows that a renderer fault costs the chart, not the email.
var testChartHook func(alertchart.Spec)

// chartFor draws a stock's short-position chart from its stored history, in the light
// and the dark palette. It returns nils when there is nothing to draw: an industry
// alert, an event with no stock detail, or fewer than two readings. A render error,
// or a panic in the renderer, also yields nils, so a chart fault never stops the
// alert itself. The same fault recurs on every retry, which is why the email goes
// out without the chart rather than not at all.
func chartFor(m Message) (light, dark []byte) {
	defer func() {
		if r := recover(); r != nil {
			log.Printf("alerts: chart for %s not drawn, the email goes without it: %v", m.Target, r)
			light, dark = nil, nil
		}
	}()
	if m.Scope != alertevents.ScopeStock || m.Payload.Stock == nil {
		return nil, nil
	}
	hist := m.Payload.Stock.History
	if len(hist) < alertchart.MinPoints {
		return nil, nil
	}
	pts := make([]alertchart.Point, 0, len(hist))
	for _, h := range hist {
		pts = append(pts, alertchart.Point{Date: h.D, Value: h.P})
	}
	spec := alertchart.Spec{Points: pts, ReportDate: string(m.ReportDate), ComparedTo: string(m.ComparedTo)}
	if m.Condition == alertevents.ConditionShortInterestAbove && m.Threshold != nil {
		spec.Threshold = m.Threshold
	}
	if testChartHook != nil {
		testChartHook(spec)
	}
	light, err := alertchart.Render(spec)
	if err != nil {
		return nil, nil
	}
	dark, err = alertchart.RenderDark(spec)
	if err != nil {
		return nil, nil
	}
	return light, dark
}

// chartMemo holds the charts one delivery pass has drawn, so many owners of one stock
// share a render. The key is the whole chart spec: the code, both report dates, the
// threshold when the condition uses one, and every point of the history. A nil memo
// draws every chart.
type chartMemo struct {
	drawn map[[32]byte][2][]byte
}

func newChartMemo() *chartMemo {
	return &chartMemo{drawn: map[[32]byte][2][]byte{}}
}

// get returns the charts for m, drawing them on the first request for their spec. A
// spec with no chart is not memoised, so a fault is retried for the next owner.
func (c *chartMemo) get(m Message) (light, dark []byte) {
	if c == nil {
		return chartFor(m)
	}
	key := chartKey(m)
	if pair, ok := c.drawn[key]; ok {
		return pair[0], pair[1]
	}
	light, dark = chartFor(m)
	if light != nil {
		c.drawn[key] = [2][]byte{light, dark}
	}
	return light, dark
}

// chartKey hashes everything the chart is drawn from. Two messages with the same key
// draw the same bytes.
func chartKey(m Message) [32]byte {
	var b strings.Builder
	fmt.Fprintf(&b, "%s|%s|%s|%s|", m.Target, m.ReportDate, m.ComparedTo, m.Condition)
	if m.Threshold != nil && m.Condition == alertevents.ConditionShortInterestAbove {
		fmt.Fprintf(&b, "t=%s|", strconv.FormatFloat(*m.Threshold, 'g', -1, 64))
	}
	if st := m.Payload.Stock; st != nil {
		for _, h := range st.History {
			fmt.Fprintf(&b, "%s=%s;", h.D, strconv.FormatFloat(h.P, 'g', -1, 64))
		}
	}
	return sha256.Sum256([]byte(b.String()))
}

// plainInput is what the plain-text twin needs beyond the message.
type plainInput struct {
	subject   string
	headers   []string
	rows      [][]string
	more      int
	moreURL   string
	viewURL   string
	viewLabel string
	summary   string
	pauseURL  string
	manageURL string
}

// plainText is the plain-text twin: the subject, the figures, the stats when there
// are any, the table for an industry, the provenance, the view link and the footer.
func plainText(m Message, in plainInput) string {
	var text bytes.Buffer
	text.WriteString(in.subject + "\n\n")
	if m.Scope == alertevents.ScopeStock {
		text.WriteString(stockHeading(m) + "\n")
	}
	text.WriteString(introLine(m) + "\n")
	if scope := scopeLine(m); scope != "" {
		text.WriteString(scope + "\n")
	}
	text.WriteString("ASIC publishes positions four trading days after they are held.\n")

	if m.Scope == alertevents.ScopeStock {
		text.WriteString("\n")
		prevDate := stockPreviousDate(m)
		fmt.Fprintf(&text, "Previous: %s (%s)\n", pct(m.Previous), fmtDay(prevDate))
		fmt.Fprintf(&text, "Latest:   %s (%s)\n", pct(m.Latest), fmtDay(m.ReportDate))
		if ch := stockChange(m); ch != nil {
			fmt.Fprintf(&text, "Change:   %s pts\n", signedPts(*ch))
		}
		if st := m.Payload.Stock; st != nil {
			if st.SharesShort != nil {
				fmt.Fprintf(&text, "Shares short:      %s\n", compactShares(*st.SharesShort))
			}
			if st.SharesOnIssue != nil {
				fmt.Fprintf(&text, "Shares on issue:   %s\n", compactShares(*st.SharesOnIssue))
			}
			if st.Rank > 0 {
				fmt.Fprintf(&text, "Most-shorted rank: #%d of %d (%s)\n", st.Rank, st.Ranked, fmtDay(m.ReportDate))
			}
			if st.Change20 != nil && st.Change20Date != "" {
				fmt.Fprintf(&text, "Change since %s: %s pts\n", dayMonth(Date(st.Change20Date)), signedPts(*st.Change20))
			}
		}
		text.WriteString("\n")
	} else {
		text.WriteString("\n")
		text.WriteString(textRow(in.headers, textWidths(m)) + "\n")
		for _, r := range in.rows {
			text.WriteString(textRow(r, textWidths(m)) + "\n")
		}
		if in.more > 0 {
			fmt.Fprintf(&text, "… and %d more: %s\n", in.more, in.moreURL)
		}
		text.WriteString("\n")
	}
	if in.viewURL != "" {
		fmt.Fprintf(&text, "%s: %s\n", in.viewLabel, in.viewURL)
	}
	text.WriteString("--\n")
	fmt.Fprintf(&text, "You set up this alert on Shorted: %s.\n", in.summary)
	fmt.Fprintf(&text, "Pause this alert: %s\n", in.pauseURL)
	fmt.Fprintf(&text, "Manage your alerts: %s\n", in.manageURL)
	fmt.Fprintf(&text, "General information only, not financial advice. Shorted · %s\n", footerContact)
	return text.String()
}

// stockHeading names the company at the top of a stock email's text twin:
// "GLC — Glencore (Materials)", or the code alone when nothing else is known.
func stockHeading(m Message) string {
	name := displayName(m)
	industry := ""
	if st := m.Payload.Stock; st != nil {
		industry = st.Industry
	}
	heading := m.Target
	if name != "" && name != m.Target {
		heading += " — " + name
	}
	if industry != "" {
		heading += " (" + industry + ")"
	}
	return heading
}

// stockPreviousDate is the report the previous reading came from. It is the
// compared report unless the company's own record says it was an earlier one.
func stockPreviousDate(m Message) Date {
	if len(m.Payload.Companies) > 0 && m.Payload.Companies[0].PreviousDate != "" {
		return Date(m.Payload.Companies[0].PreviousDate)
	}
	return m.ComparedTo
}

// stockChange is latest minus previous in points, or nil when either is missing.
func stockChange(m Message) *float64 {
	if m.Latest == nil || m.Previous == nil {
		return nil
	}
	c := round2(*m.Latest - *m.Previous)
	return &c
}

// signedPts formats a change in points with its sign: +5.16, -0.40.
func signedPts(v float64) string {
	return fmt.Sprintf("%+.2f", v)
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
		if m.Scope == alertevents.ScopeIndustry {
			return fmt.Sprintf("%s - any company's short interest above %s%% - %s", m.Target, numStr(*m.Threshold), m.Cadence)
		}
		return fmt.Sprintf("%s - short interest above %s%% - %s", m.Target, numStr(*m.Threshold), m.Cadence)
	case alertevents.ConditionShortInterestRises:
		if m.Scope == alertevents.ScopeIndustry {
			return fmt.Sprintf("%s - any company's short interest rises by %s pts - %s", m.Target, numStr(*m.Threshold), m.Cadence)
		}
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

// scopeLine says what an industry alert checked. Every company in the industry is
// evaluated, and the email lists the ones that triggered, so the reader is never
// left to guess whether one company or the whole industry was watched. A stock
// alert watches one code, so it needs no such line.
func scopeLine(m Message) string {
	if m.Scope != alertevents.ScopeIndustry {
		return ""
	}
	switch m.Condition {
	case alertevents.ConditionShortInterestAbove:
		return fmt.Sprintf("Every company in %s was checked. This lists each one that crossed %s%% short interest.", m.Target, numStr(*m.Threshold))
	case alertevents.ConditionShortInterestRises:
		return fmt.Sprintf("Every company in %s was checked. This lists each one whose short interest rose by at least %s pts.", m.Target, numStr(*m.Threshold))
	case alertevents.ConditionNewTopTenEntry:
		return fmt.Sprintf("Every company in %s was ranked. This lists each one that entered the industry's top ten.", m.Target)
	}
	return ""
}

// datedFigure labels a figure with its own report date when that report is not the
// one the email compares with. A lookback reading was taken on an earlier report,
// and printing it without its date would read as the compared report's figure.
func datedFigure(text, figureDate string, compared Date) string {
	if figureDate == "" || Date(figureDate) == compared {
		return text
	}
	return fmt.Sprintf("%s (%s)", text, fmtDay(Date(figureDate)))
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
			rows = append(rows, []string{c.Code, c.Name, datedFigure(rankOf(c.PreviousRank), c.PreviousDate, m.ComparedTo), rankOf(c.Rank), pct(&c.Latest)})
		}
	} else {
		headers = []string{"Code", "Company", "Previous", "Latest", "Change"}
		for _, c := range cs {
			latest := c.Latest
			rows = append(rows, []string{c.Code, c.Name, datedFigure(pct(c.Previous), c.PreviousDate, m.ComparedTo), pct(&latest), signed(c.Change)})
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
