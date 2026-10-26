package alerts

import (
	"bytes"
	"fmt"
	"html/template"
	"math"
	"strconv"
	"strings"

	"github.com/castlemilk/shorted.com.au/services/pkg/alertevents"
)

// The HTML twin. It is table-based and inline-styled, because email clients drop
// most of what a stylesheet would give. The one <style> block carries only the
// mobile tweaks and the dark mode, which a client that ignores it simply loses.
// Every dynamic string goes through html/template, so a company name with "&" or
// "<" is shown as written and cannot break the markup.
//
// Type is mono throughout, as the brand has it, with the serif reserved for the
// headline. Every text colour is checked to 4.5:1 on its background in both modes.

// Font stacks. The mono stack is set on every text element, because a client that
// drops the body style would otherwise fall back to a serif.
const (
	monoStack  = "'IBM Plex Mono', ui-monospace, Menlo, Consolas, monospace"
	serifStack = "Newsreader, Georgia, 'Times New Roman', serif"
)

// htmlInput is what the HTML twin is built from: the message and the parts of the
// plain-text build it shares.
type htmlInput struct {
	msg       Message
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
	hasChart  bool
}

// htmlPage is the data the template reads. The stock and table sections are set by
// scope, and the card's shared parts (eyebrow, headline, button, provenance) are
// set for both.
type htmlPage struct {
	Title      string
	Preheader  string
	Eyebrow    string
	Headline   string
	ScopeNote  string
	Provenance string
	ViewURL    string
	ViewLabel  string
	Summary    string
	PauseURL   string
	ManageURL  string
	Footer     string
	Stock      *stockView
	Table      *tableView
}

// stockView is the stock card's company row, figures, chart and stats.
type stockView struct {
	Code     string
	NameLine string // "Glencore · Materials", or whichever of the two is known
	Logo     string
	HasLogo  bool
	Previous string
	Latest   string
	// PreviousDate and LatestDate are the short day labels under the figures.
	PreviousDate string
	LatestDate   string
	HasChange    bool
	Change       string
	ChangeClass  string
	ChangeColor  string
	ChangeBg     string
	HasChart     bool
	ChartAlt     string
	ChartCaption string
	StatRows     [][]stat
}

// stat is one cell of the stats grid. An empty Label is a blank cell that keeps
// the grid's two columns aligned.
type stat struct {
	Label, Value, Sub, Class, Color string
}

// tableView is the industry card's company table.
type tableView struct {
	Headers []header
	Rows    []tableRow
	HasMore bool
	More    int
	MoreURL string
}

type header struct {
	Text  string
	Right bool
}

type tableRow struct {
	Code, Name, Logo string
	HasLogo          bool
	Cells            []cell
}

// cell is one figure in a table row. Sub is a smaller line under the figure, used
// for the short date of a lookback reading.
type cell struct {
	Text, Class, Color, Sub string
}

// Colours for direction. A rise in short interest is red, as the site's tables show
// it; a fall is green. A zero change is neutral. The rise red is darker than the
// site's signal red, because the signal red is 3.3:1 on its chip and 4.5:1 is the
// floor. Both the light and dark pairs are checked to that floor.
const (
	riseText   = "#B91C1C" // 5.7:1 on riseChip
	riseChip   = "#FDECEC"
	fallText   = "#15803D" // 4.5:1 on fallChip
	fallChip   = "#E9F7EE"
	flatText   = "#72625A" // 5.7:1 on the card
	flatChip   = "#F2F0ED"
	inkColor   = "#483932"
	mutedColor = "#72625A"
)

// deltaStyle is the text class, text colour and chip background for a change.
func deltaStyle(v float64) (textClass, textColor, chipClass, chipBg string) {
	switch {
	case v > 0:
		return "txt-up", riseText, "chip-up", riseChip
	case v < 0:
		return "txt-down", fallText, "chip-down", fallChip
	}
	return "muted", flatText, "chip-flat", flatChip
}

// renderHTML builds the HTML twin for one message.
func renderHTML(in htmlInput) (string, error) {
	var b bytes.Buffer
	if err := alertPage.Execute(&b, buildPage(in)); err != nil {
		return "", err
	}
	return b.String(), nil
}

func buildPage(in htmlInput) htmlPage {
	m := in.msg
	p := htmlPage{
		Title:      in.subject,
		Preheader:  in.subject,
		Provenance: introLine(m) + " ASIC publishes positions four trading days after they are held.",
		ViewURL:    in.viewURL,
		ViewLabel:  in.viewLabel,
		Summary:    in.summary,
		PauseURL:   in.pauseURL,
		ManageURL:  in.manageURL,
		Footer:     footerContact,
	}
	if m.Scope == alertevents.ScopeStock {
		st := buildStock(m, in.hasChart)
		p.Stock = &st
		p.Preheader = stockPreheader(m)
		p.Eyebrow = stockEyebrow(m)
		p.Headline = stockHeadline(m)
		return p
	}
	t := buildTable(m, in.more, in.moreURL)
	p.Table = &t
	p.Eyebrow = industryEyebrow(m)
	p.Headline = in.subject
	p.ScopeNote = scopeLine(m)
	return p
}

func buildStock(m Message, hasChart bool) stockView {
	v := stockView{Code: m.Target}
	var name, industry, logo string
	if st := m.Payload.Stock; st != nil {
		name, industry, logo = st.Name, st.Industry, st.LogoURL
	}
	if len(m.Payload.Companies) > 0 {
		c := m.Payload.Companies[0]
		if name == "" {
			name = c.Name
		}
		if logo == "" {
			logo = c.LogoURL
		}
	}
	v.NameLine = joinNonEmpty(" · ", name, industry)
	v.Logo = usableLogo(logo)
	v.HasLogo = v.Logo != ""

	v.Previous = dashIfNil(m.Previous)
	v.Latest = dashIfNil(m.Latest)
	v.PreviousDate = shortDay(stockPreviousDate(m))
	v.LatestDate = shortDay(m.ReportDate)

	if ch := stockChange(m); ch != nil {
		_, textColor, chipClass, chipBg := deltaStyle(*ch)
		v.HasChange = true
		v.Change = signedPts(*ch) + " pts"
		v.ChangeClass = chipClass
		v.ChangeColor = textColor
		v.ChangeBg = chipBg
	}

	v.HasChart = hasChart
	short := historyIsShort(m)
	middle := "ending at " + pct(m.Latest)
	if m.Condition == alertevents.ConditionShortInterestAbove && m.Threshold != nil {
		middle = "crossing " + numStr(*m.Threshold) + "%"
	}
	if short {
		// A short history names how many reports it has and the dates they cover,
		// never "since first reported": the history window is 190 days, so the first
		// reading is not necessarily the code's first report.
		span := reportsSpan(m)
		v.ChartAlt = fmt.Sprintf("%s short interest over %s, %s on %s", displayName(m), span, middle, fmtDay(m.ReportDate))
		v.ChartCaption = "Short position, % of shares on issue · ASIC daily reports · " + span
	} else {
		span := historySpan(m)
		v.ChartAlt = fmt.Sprintf("%s short interest %s, %s on %s", displayName(m), span, middle, fmtDay(m.ReportDate))
		v.ChartCaption = "Short position, % of shares on issue · ASIC daily reports · " + span
	}

	v.StatRows = pairStats(statsOf(m))
	return v
}

// historyIsShort is true when the stored history has fewer than twenty readings, the
// case the chart draws with a dot on every day.
func historyIsShort(m Message) bool {
	st := m.Payload.Stock
	return st != nil && len(st.History) > 0 && len(st.History) < 20
}

// joinNonEmpty joins the non-empty parts with sep.
func joinNonEmpty(sep string, parts ...string) string {
	var out []string
	for _, p := range parts {
		if p != "" {
			out = append(out, p)
		}
	}
	return strings.Join(out, sep)
}

// historySpan is the date range a long history covers, as the caption writes it:
// "17 Apr – 16 Oct 2026", "17 Nov 2025 – 16 Oct 2026".
func historySpan(m Message) string {
	st := m.Payload.Stock
	if st == nil || len(st.History) == 0 {
		return "last 6 months"
	}
	return dateRange(Date(st.History[0].D), Date(st.History[len(st.History)-1].D))
}

// reportsSpan is a short history's count and range: "3 reports, 14–16 Oct 2026".
func reportsSpan(m Message) string {
	st := m.Payload.Stock
	n := len(st.History)
	noun := "reports"
	if n == 1 {
		noun = "report"
	}
	return fmt.Sprintf("%d %s, %s", n, noun, dateRange(Date(st.History[0].D), Date(st.History[n-1].D)))
}

// dateRange writes two report dates as a range. One date when they match, the month
// once when they share one, the year once at the end when they share one, and the
// full date at each end when they do not.
func dateRange(a, b Date) string {
	at, err1 := a.Day()
	bt, err2 := b.Day()
	if err1 != nil || err2 != nil {
		return string(a) + " – " + string(b)
	}
	switch {
	case at.Equal(bt):
		return at.Format("2 Jan 2006")
	case at.Year() == bt.Year() && at.Month() == bt.Month():
		return at.Format("2") + "–" + bt.Format("2 Jan 2006")
	case at.Year() == bt.Year():
		return at.Format("2 Jan") + " – " + bt.Format("2 Jan 2006")
	}
	return at.Format("2 Jan 2006") + " – " + bt.Format("2 Jan 2006")
}

// statsOf is the stats grid's cells, in order. A cell whose figure is missing is
// left out, so the grid never shows a blank value.
func statsOf(m Message) []stat {
	st := m.Payload.Stock
	if st == nil {
		return nil
	}
	var out []stat
	if st.SharesShort != nil {
		out = append(out, stat{Label: "SHARES SHORT", Value: compactShares(*st.SharesShort), Class: "ink", Color: inkColor})
	}
	if st.SharesOnIssue != nil {
		out = append(out, stat{Label: "SHARES ON ISSUE", Value: compactShares(*st.SharesOnIssue), Class: "ink", Color: inkColor})
	}
	if st.Rank > 0 {
		out = append(out, stat{
			Label: "MOST-SHORTED RANK",
			Value: fmt.Sprintf("#%d of %d", st.Rank, st.Ranked),
			Sub:   "on " + shortDay(m.ReportDate),
			Class: "ink",
			Color: inkColor,
		})
	}
	// The change is labelled with the day it is measured from. Without that day the
	// label would claim a span it cannot name, so the cell is left out.
	if st.Change20 != nil && st.Change20Date != "" {
		textClass, textColor, _, _ := deltaStyle(*st.Change20)
		out = append(out, stat{
			Label: "CHANGE SINCE " + strings.ToUpper(dayMonth(Date(st.Change20Date))),
			Value: signedPts(*st.Change20) + " pts",
			Class: textClass, Color: textColor,
		})
	}
	return out
}

// pairStats lays the cells out two to a row, padding an odd last row with a blank
// cell so the columns stay aligned. The grid keeps two columns on a phone too.
func pairStats(cells []stat) [][]stat {
	var rows [][]stat
	for i := 0; i < len(cells); i += 2 {
		row := []stat{cells[i]}
		if i+1 < len(cells) {
			row = append(row, cells[i+1])
		} else {
			row = append(row, stat{})
		}
		rows = append(rows, row)
	}
	return rows
}

func buildTable(m Message, more int, moreURL string) tableView {
	t := tableView{MoreURL: moreURL, More: more, HasMore: more > 0}
	if m.Condition == alertevents.ConditionNewTopTenEntry {
		t.Headers = []header{{Text: ""}, {Text: "Company"}, {Text: "Latest", Right: true}, {Text: "Rank before → now", Right: true}}
	} else {
		t.Headers = []header{{Text: ""}, {Text: "Company"}, {Text: "Previous", Right: true}, {Text: "Latest", Right: true}, {Text: "Change", Right: true}}
	}
	cs := m.Payload.Companies
	if len(cs) > emailTableRows {
		cs = cs[:emailTableRows]
	}
	for _, c := range cs {
		logo := usableLogo(c.LogoURL)
		r := tableRow{Code: c.Code, Name: c.Name, Logo: logo, HasLogo: logo != ""}
		latest := c.Latest
		if m.Condition == alertevents.ConditionNewTopTenEntry {
			r.Cells = []cell{
				{Text: pct(&latest), Class: "ink", Color: inkColor},
				{Text: rankOf(c.PreviousRank) + " → " + rankOf(c.Rank), Class: "muted", Color: mutedColor},
			}
		} else {
			// A lookback reading carries its own report's short date under it, so the
			// figure is never read as the compared report's.
			sub := ""
			if c.PreviousDate != "" && Date(c.PreviousDate) != m.ComparedTo {
				sub = dayMonth(Date(c.PreviousDate))
			}
			textClass, textColor := "muted", flatText
			text := "-"
			if c.Change != nil {
				textClass, textColor, _, _ = deltaStyle(*c.Change)
				text = signed(c.Change)
			}
			r.Cells = []cell{
				{Text: pct(c.Previous), Sub: sub, Class: "muted", Color: mutedColor},
				{Text: pct(&latest), Class: "ink", Color: inkColor},
				{Text: text, Class: textClass, Color: textColor},
			}
		}
		t.Rows = append(t.Rows, r)
	}
	return t
}

// displayName is the company name when it is known, else the code.
func displayName(m Message) string {
	if st := m.Payload.Stock; st != nil && st.Name != "" {
		return st.Name
	}
	if len(m.Payload.Companies) > 0 && m.Payload.Companies[0].Name != "" {
		return m.Payload.Companies[0].Name
	}
	return m.Target
}

func stockEyebrow(m Message) string {
	cad := strings.ToUpper(m.Cadence)
	if m.Condition == alertevents.ConditionShortInterestRises {
		if ch := stockChange(m); ch != nil {
			return fmt.Sprintf("UP %s PTS · %s ALERT", numStr(math.Abs(*ch)), cad)
		}
	}
	if m.Threshold != nil && m.Condition == alertevents.ConditionShortInterestAbove {
		return fmt.Sprintf("CROSSED %s%% · %s ALERT", numStr(*m.Threshold), cad)
	}
	return cad + " ALERT"
}

func stockHeadline(m Message) string {
	name := displayName(m)
	if m.Condition == alertevents.ConditionShortInterestRises {
		if ch := stockChange(m); ch != nil {
			return fmt.Sprintf("%s short interest rose %s pts", name, numStr(math.Abs(*ch)))
		}
	}
	if m.Threshold != nil {
		return fmt.Sprintf("%s short interest crossed %s%%", name, numStr(*m.Threshold))
	}
	return name + " short interest alert"
}

// stockPreheader is the line a mail client shows after the subject in an inbox.
func stockPreheader(m Message) string {
	if m.Condition == alertevents.ConditionShortInterestRises {
		if ch := stockChange(m); ch != nil {
			return fmt.Sprintf("%s short interest rose %s pts: %s → %s on %s",
				m.Target, numStr(math.Abs(*ch)), dashIfNil(m.Previous), dashIfNil(m.Latest), shortDay(m.ReportDate))
		}
	}
	thr := ""
	if m.Threshold != nil {
		thr = numStr(*m.Threshold)
	}
	return fmt.Sprintf("%s short interest crossed %s%%: %s → %s on %s",
		m.Target, thr, dashIfNil(m.Previous), dashIfNil(m.Latest), shortDay(m.ReportDate))
}

func industryEyebrow(m Message) string {
	n := m.Payload.CompaniesTotal
	label := strings.ToUpper(m.Target)
	plural := "COMPANIES"
	if n == 1 {
		plural = "COMPANY"
	}
	switch m.Condition {
	case alertevents.ConditionShortInterestRises:
		if m.Threshold != nil {
			return fmt.Sprintf("%s · %d %s ROSE %s+ PTS", label, n, plural, numStr(*m.Threshold))
		}
	case alertevents.ConditionNewTopTenEntry:
		return fmt.Sprintf("%s · %d %s ENTERED THE TOP 10", label, n, plural)
	}
	if m.Threshold != nil {
		return fmt.Sprintf("%s · %d %s CROSSED %s%%", label, n, plural, numStr(*m.Threshold))
	}
	return label + " · " + strconv.Itoa(n) + " " + plural
}

func dashIfNil(v *float64) string {
	if v == nil {
		return "-"
	}
	return pct(v)
}

// shortDay formats a report date without its year: "Fri 16 Oct".
func shortDay(d Date) string {
	t, err := d.Day()
	if err != nil {
		return string(d)
	}
	return t.Format("Mon 2 Jan")
}

// dayMonth formats a report date as day and month only: "14 Oct".
func dayMonth(d Date) string {
	t, err := d.Day()
	if err != nil {
		return string(d)
	}
	return t.Format("2 Jan")
}

// compactShares formats a share count with three significant figures and a K, M or
// B suffix: 1.24B, 12.1B, 850K. A value that would round up into the next unit is
// shown in that unit.
func compactShares(v float64) string {
	a := math.Abs(v)
	switch {
	case a >= 999.5e6:
		return sigFigures(v/1e9) + "B"
	case a >= 999.5e3:
		return sigFigures(v/1e6) + "M"
	case a >= 999.5:
		return sigFigures(v/1e3) + "K"
	}
	return sigFigures(v)
}

// sigFigures formats a number to three significant figures. Rounding can carry a
// value into the next decade (9.999 becomes 10.0), so the precision is chosen again
// from the rounded value.
func sigFigures(v float64) string {
	dec := sigDecimals(math.Abs(v))
	rounded, _ := strconv.ParseFloat(strconv.FormatFloat(v, 'f', dec, 64), 64)
	dec = sigDecimals(math.Abs(rounded))
	return strconv.FormatFloat(v, 'f', dec, 64)
}

// sigDecimals is the number of decimals that gives three significant figures for a.
func sigDecimals(a float64) int {
	switch {
	case a >= 100:
		return 0
	case a >= 10:
		return 1
	}
	return 2
}

// alertPage is the template both scopes share. Its section for a scope is set only
// when that scope has data, and the stock chart is omitted when there is no chart.
var alertPage = template.Must(template.New("alert").Parse(
	strings.NewReplacer("FONT_MONO", monoStack, "SERIF_STACK", serifStack).Replace(alertPageHTML)))

// alertPageHTML is the email. FONT_MONO is replaced with monoStack when the template
// is parsed, so each element names the mono stack without repeating it by hand.
const alertPageHTML = `<!doctype html>
<html lang="en-AU">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>{{.Title}}</title>
<style>
.stat-l { padding: 14px 14px 14px 0; }
.stat-r { padding: 14px 0 14px 14px; border-left: 1px solid #E5E1DC; }
.stat-t { border-top: 1px solid #E5E1DC; }
.dark-chart { display: none; max-height: 0; overflow: hidden; mso-hide: all; }
.chart-img { box-sizing: border-box; }
.fig-m { display: none; }
@media only screen and (max-width: 480px) {
  .pad { padding: 20px !important; }
  .fluid { width: 100% !important; }
  .fig-a, .fig-b { width: 50% !important; }
  .fig-c { display: none !important; }
  .fig-m { display: table-row !important; }
  .stat-l { padding: 12px 10px 12px 0 !important; }
  .stat-r { padding: 12px 0 12px 10px !important; }
  .stat-val { font-size: 15px !important; }
  .cta-tbl { width: 100% !important; }
  .cta-cell { width: 100% !important; padding: 0 !important; }
  .cta-link { display: block !important; width: 100% !important; text-align: center !important; box-sizing: border-box; }
}
@media (prefers-color-scheme: dark) {
  .bg { background-color: #0D0D0D !important; }
  .card { background-color: #121212 !important; border-color: #352E27 !important; }
  .ink { color: #E8DEB5 !important; }
  .muted { color: #A39A75 !important; }
  .accent { color: #FFAC4D !important; }
  .hair { border-color: #352E27 !important; }
  .stat-r { border-left-color: #352E27 !important; border-top-color: #352E27 !important; }
  .stat-t { border-top-color: #352E27 !important; }
  .tile { background-color: #1C1915 !important; }
  .btn { background-color: #FFAC4D !important; }
  .btn-text { color: #0D0D0D !important; }
  .chip-up { background-color: #3B1616 !important; color: #F87171 !important; }
  .chip-down { background-color: #123222 !important; color: #4ADE80 !important; }
  .chip-flat { background-color: #1C1915 !important; color: #A39A75 !important; }
  .txt-up { color: #F87171 !important; }
  .txt-down { color: #4ADE80 !important; }
  .light-chart { display: none !important; }
  .dark-chart { display: block !important; max-height: none !important; overflow: visible !important; }
}
</style>
</head>
<body class="bg" style="margin:0;padding:0;background-color:#F9F8F5;font-family:FONT_MONO;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;font-size:1px;line-height:1px;color:#F9F8F5;mso-hide:all;">{{.Preheader}}</div>
<table role="presentation" class="bg" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#F9F8F5;">
<tr><td align="center" style="padding:24px 12px;font-family:FONT_MONO;">
<table role="presentation" class="fluid" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;">
<tr><td style="padding:0 0 18px 0;font-family:FONT_MONO;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
<td align="left" valign="middle" style="font-family:FONT_MONO;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
<td valign="middle" style="font-family:FONT_MONO;"><img src="cid:shorted-mark" width="38" height="32" alt="Shorted" style="display:block;border:0;width:38px;height:32px;"></td>
<td valign="middle" class="ink" style="padding-left:10px;font-family:FONT_MONO;font-weight:600;font-size:18px;line-height:32px;color:#483932;">Shorted</td>
</tr></table>
</td>
<td align="right" valign="middle" class="muted" style="font-family:FONT_MONO;font-size:11px;line-height:16px;letter-spacing:0.16em;text-transform:uppercase;color:#72625A;">Short interest alert</td>
</tr></table>
</td></tr>
<tr><td class="card pad" style="background-color:#FDFDFC;border:1px solid #E5E1DC;border-radius:6px;padding:28px;font-family:FONT_MONO;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
{{with .Stock}}
<tr><td style="font-family:FONT_MONO;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
<td valign="middle" width="40" style="width:40px;font-family:FONT_MONO;">
{{if .HasLogo}}<img src="{{.Logo}}" width="40" height="40" alt="{{.Code}}" style="display:block;width:40px;height:40px;border-radius:6px;border:1px solid #E5E1DC;">{{else}}<table role="presentation" width="40" height="40" cellpadding="0" cellspacing="0" border="0" class="tile" style="width:40px;height:40px;background-color:#F2F0ED;border-radius:6px;"><tr><td align="center" valign="middle" class="accent" style="font-family:FONT_MONO;font-weight:600;font-size:13px;line-height:40px;color:#9E5210;">{{.Code}}</td></tr></table>{{end}}
</td>
<td valign="middle" style="padding-left:14px;font-family:FONT_MONO;">
<div class="ink" style="font-family:FONT_MONO;font-weight:600;font-size:16px;line-height:24px;color:#483932;">{{.Code}}</div>
{{if .NameLine}}<div class="muted" style="font-family:FONT_MONO;font-size:13px;line-height:20px;color:#72625A;">{{.NameLine}}</div>{{end}}
</td>
</tr></table>
</td></tr>
{{end}}
<tr><td style="padding-top:{{if .Stock}}20{{else}}0{{end}}px;font-family:FONT_MONO;">
<div class="accent" style="font-family:FONT_MONO;font-size:11px;line-height:16px;letter-spacing:0.16em;text-transform:uppercase;color:#9E5210;">{{.Eyebrow}}</div>
</td></tr>
<tr><td style="font-family:FONT_MONO;padding-top:8px;">
<h1 class="ink" style="margin:0;font-family:SERIF_STACK;font-size:26px;line-height:1.25;font-weight:700;color:#483932;">{{.Headline}}</h1>
</td></tr>
{{if .ScopeNote}}<tr><td class="muted" style="padding-top:10px;font-family:FONT_MONO;font-size:13px;line-height:20px;color:#72625A;">{{.ScopeNote}}</td></tr>{{end}}
{{with .Stock}}
<tr><td style="padding-top:22px;font-family:FONT_MONO;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
<td class="fig fig-a" width="34%" valign="top" style="width:34%;padding-right:12px;font-family:FONT_MONO;">
<div class="muted" style="font-family:FONT_MONO;font-size:11px;line-height:16px;letter-spacing:0.12em;text-transform:uppercase;color:#72625A;">Previous</div>
<div class="ink stat-val" style="font-family:FONT_MONO;font-size:22px;line-height:30px;color:#483932;">{{.Previous}}</div>
<div class="muted" style="font-family:FONT_MONO;font-size:12px;line-height:18px;color:#72625A;">{{.PreviousDate}}</div>
</td>
<td class="fig fig-b" width="34%" valign="top" style="width:34%;padding-right:12px;font-family:FONT_MONO;">
<div class="muted" style="font-family:FONT_MONO;font-size:11px;line-height:16px;letter-spacing:0.12em;text-transform:uppercase;color:#72625A;">Latest</div>
<div class="ink" style="font-family:FONT_MONO;font-weight:600;font-size:30px;line-height:36px;color:#483932;">{{.Latest}}</div>
<div class="muted" style="font-family:FONT_MONO;font-size:12px;line-height:18px;color:#72625A;">{{.LatestDate}}</div>
</td>
<td class="fig fig-c" width="32%" valign="top" style="width:32%;font-family:FONT_MONO;">
<div class="muted" style="font-family:FONT_MONO;font-size:11px;line-height:16px;letter-spacing:0.12em;text-transform:uppercase;color:#72625A;">Change</div>
{{if .HasChange}}<span class="{{.ChangeClass}}" style="display:inline-block;margin-top:6px;font-family:FONT_MONO;font-weight:600;font-size:15px;line-height:22px;padding:3px 10px;border-radius:4px;color:{{.ChangeColor}};background-color:{{.ChangeBg}};">{{.Change}}</span>{{end}}
</td>
</tr>
<tr class="fig-m"><td colspan="2" style="padding-top:16px;font-family:FONT_MONO;">
<div class="muted" style="font-family:FONT_MONO;font-size:11px;line-height:16px;letter-spacing:0.12em;text-transform:uppercase;color:#72625A;">Change</div>
{{if .HasChange}}<span class="{{.ChangeClass}}" style="display:inline-block;margin-top:6px;font-family:FONT_MONO;font-weight:600;font-size:15px;line-height:22px;padding:3px 10px;border-radius:4px;color:{{.ChangeColor}};background-color:{{.ChangeBg}};">{{.Change}}</span>{{end}}
</td></tr>
</table>
</td></tr>
{{if .HasChart}}
<tr><td style="padding-top:22px;font-family:FONT_MONO;">
<img class="light-chart chart-img" src="cid:chart" width="552" alt="{{.ChartAlt}}" style="display:block;box-sizing:border-box;width:100%;max-width:552px;height:auto;border:1px solid #E5E1DC;border-radius:6px;">
<div class="dark-chart" style="display:none;max-height:0;overflow:hidden;mso-hide:all;"><img class="chart-img" src="cid:chart-dark" width="552" alt="{{.ChartAlt}}" style="display:block;box-sizing:border-box;width:100%;max-width:552px;height:auto;border:1px solid #352E27;border-radius:6px;"></div>
<p class="muted" style="margin:8px 0 0 0;font-family:FONT_MONO;font-size:11px;line-height:16px;color:#72625A;">{{.ChartCaption}}</p>
</td></tr>
{{end}}
{{if .StatRows}}
<tr><td style="padding-top:22px;font-family:FONT_MONO;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
{{range $i, $row := .StatRows}}<tr>{{range $j, $c := $row}}<td class="stat-{{if $j}}r{{else}}l{{end}}{{if $i}} stat-t{{end}}" width="50%" valign="top" style="width:50%;font-family:FONT_MONO;">{{if $c.Label}}<div class="muted" style="font-family:FONT_MONO;font-size:11px;line-height:16px;letter-spacing:0.12em;text-transform:uppercase;color:#72625A;">{{$c.Label}}</div><div class="{{$c.Class}} stat-val" style="font-family:FONT_MONO;font-size:16px;line-height:24px;color:{{$c.Color}};">{{$c.Value}}</div>{{if $c.Sub}}<div class="muted" style="font-family:FONT_MONO;font-size:12px;line-height:18px;color:#72625A;">{{$c.Sub}}</div>{{end}}{{end}}</td>{{end}}</tr>
{{end}}
</table>
</td></tr>
{{end}}
{{end}}
{{with .Table}}
<tr><td style="padding-top:20px;font-family:FONT_MONO;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
<tr>{{range .Headers}}<th align="{{if .Right}}right{{else}}left{{end}}" class="muted" style="padding:0 0 8px 0;font-family:FONT_MONO;font-weight:400;font-size:11px;line-height:16px;letter-spacing:0.12em;text-transform:uppercase;color:#72625A;">{{.Text}}</th>{{end}}</tr>
{{range .Rows}}<tr>
<td valign="middle" width="20" style="width:20px;padding:10px 10px 10px 0;border-top:1px solid #E5E1DC;font-family:FONT_MONO;" class="hair">{{if .HasLogo}}<img src="{{.Logo}}" width="20" height="20" alt="{{.Code}}" style="display:block;width:20px;height:20px;border-radius:4px;border:0;">{{else}}<table role="presentation" width="20" height="20" cellpadding="0" cellspacing="0" border="0" class="tile" style="width:20px;height:20px;background-color:#F2F0ED;border-radius:4px;"><tr><td align="center" valign="middle" class="accent" style="font-family:FONT_MONO;font-weight:600;font-size:9px;line-height:20px;color:#9E5210;">{{.Code}}</td></tr></table>{{end}}</td>
<td valign="middle" width="42%" style="width:42%;padding:10px 12px 10px 0;border-top:1px solid #E5E1DC;max-width:0;font-family:FONT_MONO;" class="hair">
<div class="ink" style="font-family:FONT_MONO;font-weight:600;font-size:13px;line-height:18px;color:#483932;">{{.Code}}</div>
{{if .Name}}<div class="muted" style="font-family:FONT_MONO;font-size:12px;line-height:16px;color:#72625A;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;">{{.Name}}</div>{{end}}
</td>
{{range .Cells}}<td align="right" valign="middle" class="{{.Class}} hair" style="padding:10px 0 10px 12px;border-top:1px solid #E5E1DC;font-family:FONT_MONO;font-size:13px;line-height:18px;color:{{.Color}};">{{.Text}}{{if .Sub}}<div class="muted" style="font-family:FONT_MONO;font-size:11px;line-height:14px;color:#72625A;">{{.Sub}}</div>{{end}}</td>{{end}}
</tr>
{{end}}
</table>
{{if .HasMore}}<p class="muted" style="margin:14px 0 0 0;font-family:FONT_MONO;font-size:13px;line-height:20px;color:#72625A;">… and {{.More}} more on <a href="{{.MoreURL}}" class="accent" style="color:#9E5210;font-family:FONT_MONO;">Shorted</a></p>{{end}}
</td></tr>
{{end}}
<tr><td style="padding-top:26px;font-family:FONT_MONO;">
<table role="presentation" class="cta-tbl" cellpadding="0" cellspacing="0" border="0" style="width:auto;"><tr>
<td class="btn cta-cell" align="center" bgcolor="#9E5210" style="background-color:#9E5210;border-radius:4px;height:44px;padding:0 22px;font-family:FONT_MONO;">
<a href="{{.ViewURL}}" class="btn-text cta-link" style="display:inline-block;height:44px;line-height:44px;font-family:FONT_MONO;font-weight:600;font-size:14px;color:#F9F8F5;text-decoration:none;">{{.ViewLabel}} →</a>
</td>
</tr></table>
</td></tr>
<tr><td class="muted" style="padding-top:22px;font-family:FONT_MONO;font-size:12px;line-height:18px;color:#72625A;">{{.Provenance}}</td></tr>
</table>
</td></tr>
<tr><td class="muted" style="padding:18px 4px 0 4px;font-family:FONT_MONO;font-size:12px;line-height:18px;color:#72625A;">
<p class="muted" style="margin:0 0 6px 0;font-family:FONT_MONO;font-size:12px;line-height:18px;color:#72625A;">You set up this alert on Shorted: {{.Summary}}.</p>
<p class="muted" style="margin:0 0 6px 0;font-family:FONT_MONO;font-size:12px;line-height:18px;color:#72625A;"><a href="{{.PauseURL}}" class="accent" style="color:#9E5210;font-family:FONT_MONO;">Pause this alert</a> · <a href="{{.ManageURL}}" class="accent" style="color:#9E5210;font-family:FONT_MONO;">Manage your alerts</a></p>
<p class="muted" style="margin:0;font-family:FONT_MONO;font-size:12px;line-height:18px;color:#72625A;">General information only, not financial advice. Shorted · {{.Footer}}</p>
</td></tr>
</table>
</td></tr></table>
</body>
</html>
`
