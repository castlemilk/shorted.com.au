package ownership

import (
	"os"
	"path/filepath"
	"testing"
)

// The fixtures are the layout text (layoutText) of real ASX notices, cut to
// their form pages. Each figure below was checked against the PDF.
func TestParseSubstantialNoticeFixtures(t *testing.T) {
	tests := []struct {
		file     string
		headline string
		outcome  Outcome
		form     Form
		holder   string // tidyHolderName of the section 1 name
		inst     string // resolveInstitution slug, "" for none
		date     string
		prev     *float64
		pres     *float64
		votes    *int64
		ceased   bool
	}{
		// A bank's own layout: "Previous notice / Present notice" as one row.
		{file: "bhp_604_citigroup", headline: "Change in substantial holding", outcome: outcomeParsed, form: Form604,
			holder: "Citigroup Global Markets Australia Pty Limited", inst: "citigroup",
			prev: new(5.2988), pres: new(6.3026), votes: new(int64(320436823))},
		// Partial rows (0.23%, 4.78%) and a GRAND TOTAL: the total is the holding.
		{file: "car_603_commonwealth_bank_grand_total", outcome: outcomeParsed, form: Form603,
			holder: "Commonwealth Bank of Australia", inst: "commonwealth-bank", date: "2026-09-23",
			pres: new(5.01), votes: new(int64(19010179))},
		// A filled-in form: plain text drew every value after every label.
		{file: "flt_604_state_street_form_fields", outcome: outcomeParsed, form: Form604,
			holder: "State Street Corporation", inst: "state-street", date: "2026-10-02",
			prev: new(6.93), pres: new(7.97), votes: new(int64(16201065))},
		// An options row (0.03%) before the shares row, and prose about MUFG's
		// "voting power of over 20% in Morgan Stanley" that is no holding.
		{file: "pls_603_mufg_options_row", outcome: outcomeParsed, form: Form603,
			holder: "Mitsubishi UFJ Financial Group, Inc", inst: "mufg", date: "2026-10-13",
			pres: new(6.12), votes: new(int64(197489514))},
		// "62 , 856 , 312": every comma on its own baseline.
		{file: "zip_603_art_spaced_commas", outcome: outcomeParsed, form: Form603,
			holder: "Australian Retirement Trust Pty LTD ATF Australian Retirement Trust", inst: "australian-retirement-trust",
			date: "2026-10-14", pres: new(5.045), votes: new(int64(62856312))},
		// "110,71 2,219": one glyph of a group off its baseline.
		{file: "qan_604_australiansuper_split_group", outcome: outcomeParsed, form: Form604,
			holder: "AustralianSuper Pty Ltd", inst: "australiansuper", date: "2026-08-11",
			prev: new(6.29), pres: new(7.32), votes: new(int64(110712219))},
		// "05 Octob er 202 6" and "6.0 08 %".
		{file: "boq_604_vanguard_split_date", outcome: outcomeParsed, form: Form604,
			holder: "Vanguard Group", inst: "vanguard", date: "2026-10-05",
			prev: new(6.008), pres: new(7.008), votes: new(int64(46238183))},
		// "7.20" / "9%": a percentage cell that wrapped.
		{file: "tlc_604_vanguard_wrapped_pct", outcome: outcomeParsed, form: Form604,
			holder: "Vanguard Group", inst: "vanguard", date: "2026-10-09",
			prev: new(6.204), pres: new(7.209), votes: new(int64(160458785))},
		// "Details of subs" / "tantial holder": a label split across runs.
		{file: "nxt_605_ubs_split_label", outcome: outcomeParsed, form: Form605,
			holder: "UBS Group AG", inst: "ubs", date: "2026-09-16", ceased: true},
		// "D" / "etails of substantial holder".
		{file: "sdf_604_goldman_split_letter", outcome: outcomeParsed, form: Form604,
			holder: "The Goldman Sachs Group, Inc", inst: "goldman-sachs", date: "2026-10-01",
			prev: new(6.46), pres: new(7.48), votes: new(int64(83222440))},
		// A writer that emits a zero-width "\n" item between glyphs: read as
		// "5 5 . 05 %" it was 5.05%, not 55.05%.
		{file: "mgh_604_maas_newline_glyphs", outcome: outcomeParsed, form: Form604,
			holder: "Wesley Jon Maas and Emma Margaret Maas", date: "2026-10-16",
			prev: new(50.62), pres: new(55.05), votes: new(int64(178908133))},
		// BlackRock's form pages are scans; the annexure names the form and
		// only BlackRock's entities.
		{file: "fmg_605_blackrock_annexure_only", headline: "Ceasing to be a substantial holder", outcome: outcomeParsed,
			form: Form605, ceased: true},
		// An NZ Financial Markets Conduct Act disclosure, the ASX watermark
		// drawn between (b) and (c).
		{file: "a2m_nz_jpmorgan_watermark", outcome: outcomeParsed, form: FormNZ,
			holder: "J.P. Morgan Chase & Co", inst: "jpmorgan", date: "2026-10-13",
			prev: new(6.23), pres: new(5.21), votes: new(int64(37935318))},
		// The "Name" label drawn in the middle of a two-line value.
		{file: "cvb_604_pinnacle_label_inside_value", outcome: outcomeParsed, form: Form604,
			holder: "PINNACLE INVESTMENT MANAGEMENT GROUP LIMITED", inst: "pinnacle", date: "2026-08-28",
			prev: new(8.80), pres: new(6.74), votes: new(int64(40682305))},
		// "Form 60 4", "B ennelong".
		{file: "ctd_604_bennelong_form_60_4", outcome: outcomeParsed, form: Form604,
			holder: "Bennelong Funds Management Group Pty Ltd", inst: "bennelong", date: "2026-09-11",
			prev: new(7.0785), pres: new(10.1808), votes: new(int64(14897189))},
		{file: "min_605_l1_capital", outcome: outcomeParsed, form: Form605,
			holder: "L1 Capital Pty Ltd and L1 Capital Strategic Equity Management Pty Ltd", inst: "l1-capital",
			date: "2026-08-17", ceased: true},
		// A private equity consortium: KKR's vehicles, not Comet.
		{file: "car_603_kkr_vehicles", outcome: outcomeParsed, form: Form603, inst: "kkr", date: "2026-10-06",
			pres: new(5.01), votes: new(int64(18978899))},
		// Voting power "See Annexure B": withheld, never guessed.
		{file: "boq_603_dimensional_see_annexure", outcome: outcomeNoVotingPower, form: Form603},
		{file: "ltr_scan_no_text", headline: "Ceasing to be a substantial holder", outcome: outcomeNoText},
		// James Hardie forwards the Irish TR-1 form, not an Australian notice.
		{file: "jhx_tr1_not_a_notice", headline: "Change in substantial holding", outcome: outcomeNotNotice},
	}
	for _, tc := range tests {
		t.Run(tc.file, func(t *testing.T) {
			b, err := os.ReadFile(filepath.Join("testdata", "notices", tc.file+".txt"))
			if err != nil {
				t.Fatal(err)
			}
			n, outcome, detail := parseSubstantialNotice(string(b), tc.headline)
			if outcome != tc.outcome {
				t.Fatalf("outcome %s (%s), want %s", outcome, detail, tc.outcome)
			}
			if tc.form != "" && n.Form != tc.form {
				t.Errorf("form %s, want %s", n.Form, tc.form)
			}
			if outcome != outcomeParsed {
				return
			}
			if tc.holder != "" && tidyHolderName(n.HolderName) != tc.holder {
				t.Errorf("holder %q, want %q", tidyHolderName(n.HolderName), tc.holder)
			}
			got := ""
			if inst := resolveInstitution(n.HolderName); inst != nil {
				got = inst.Slug
			}
			if got != tc.inst {
				t.Errorf("institution %q (holder %q), want %q", got, n.HolderName, tc.inst)
			}
			if n.EventDate != tc.date {
				t.Errorf("event date %q, want %q", n.EventDate, tc.date)
			}
			checkF(t, "previous", n.PreviousPct, tc.prev)
			checkF(t, "present", n.PresentPct, tc.pres)
			if (n.PresentVotes == nil) != (tc.votes == nil) || (tc.votes != nil && *n.PresentVotes != *tc.votes) {
				t.Errorf("present votes %v, want %v", deref(n.PresentVotes), deref(tc.votes))
			}
			if n.Ceased != tc.ceased {
				t.Errorf("ceased %v, want %v", n.Ceased, tc.ceased)
			}
		})
	}
}

func checkF(t *testing.T, what string, got, want *float64) {
	t.Helper()
	if (got == nil) != (want == nil) || (want != nil && *got != *want) {
		t.Errorf("%s %v, want %v", what, derefF(got), derefF(want))
	}
}

func deref(p *int64) any {
	if p == nil {
		return nil
	}
	return *p
}

func derefF(p *float64) any {
	if p == nil {
		return nil
	}
	return *p
}

func TestSplitVotesAndPct(t *testing.T) {
	tests := []struct {
		run, frac string
		votes     *int64
		pct       float64
		ok        bool
	}{
		{"268,965,426 5", "2988", new(int64(268965426)), 5.2988, true},
		// A plain text layer glued the votes cell to the percentage cell...
		{"197,489,5146", "12", new(int64(197489514)), 6.12, true},
		// ...and the number-of-securities cell too: the votes are the last cell.
		{"197,489,514197,489,5146", "12", new(int64(197489514)), 6.12, true},
		{"10,0001,000,0000", "03", new(int64(1000000)), 0.03, true},
		// No percentage that is not also part of the votes.
		{"1,234,567", "", nil, 0, false},
		// Prose: a percentage with no votes figure before it.
		{"20", "", nil, 20, true},
		// Over 100 is no voting power.
		{"146", "12", nil, 0, false},
	}
	for _, tc := range tests {
		votes, pct, ok := splitVotesAndPct(tc.run, tc.frac)
		if ok != tc.ok || (ok && pct != tc.pct) || (ok && (votes == nil) != (tc.votes == nil)) || (ok && votes != nil && *votes != *tc.votes) {
			t.Errorf("splitVotesAndPct(%q, %q) = %v, %v, %v; want %v, %v, %v", tc.run, tc.frac, deref(votes), pct, ok, deref(tc.votes), tc.pct, tc.ok)
		}
	}
}

func TestVotingPowerTokensSkipProse(t *testing.T) {
	s := normalizeNoticeText("MUFG has voting power of over 20% in Morgan Stanley and 100% in First Sentier. Ordinary 1,234,567 6.50%")
	got := votingPowerTokens(s)
	if len(got) != 1 || got[0].pct != 6.5 || *got[0].votes != 1234567 {
		t.Fatalf("tokens %+v, want one 6.5%% with 1,234,567 votes", got)
	}
}

func TestParseNoticeDate(t *testing.T) {
	for in, want := range map[string]string{
		"23/09/2026":            "2026-09-23",
		"0 9 /09/2026":          "2026-09-09",
		"24/June/2026":          "2026-06-24",
		"2 October 2026":        "2026-10-02",
		"15-Oct-2026":           "2026-10-15",
		"October 15, 2026":      "2026-10-15",
		"05 Octob er 202 6":     "2026-10-05",
		"14 / 10 / 2026":        "2026-10-14",
		"03-August-2026":        "2026-08-03",
		"31/02/2026":            "",
		"See Annexure A":        "",
		"16 September 2026 The": "2026-09-16",
	} {
		if got := parseNoticeDate(in); got != want {
			t.Errorf("parseNoticeDate(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestChangeNoticeUnderFivePercent(t *testing.T) {
	head := "Form 604 Notice of change of interests of substantial holder 1. Details of substantial holder (1) Name Some Fund Pty Ltd ACN 1 " +
		"2. Previous and present voting power Class Ordinary %s 3. Changes in relevant interests " + padding
	// A previous figure under 5% is some other table's.
	if _, outcome, _ := parseSubstantialNotice(sprintfOne(head, "10,000,000 1.94% 4,000,000 0.91%"), ""); outcome != outcomeImplausible {
		t.Errorf("previous 1.94%%: outcome %s, want implausible", outcome)
	}
	// A fall below 5% on a 604 is a ceasing in substance.
	n, outcome, _ := parseSubstantialNotice(sprintfOne(head, "10,000,000 5.40% 9,000,000 4.80%"), "")
	if outcome != outcomeParsed || !n.Ceased || *n.PresentPct != 4.8 {
		t.Errorf("5.40%% to 4.80%%: %s ceased=%v present=%v", outcome, n.Ceased, derefF(n.PresentPct))
	}
}

// padding lifts a synthetic notice over minNoticeText.
const padding = "The total number of votes attached to all the voting shares in the company or voting interests in the scheme."

func sprintfOne(format, arg string) string {
	for i := 0; i+1 < len(format); i++ {
		if format[i] == '%' && format[i+1] == 's' {
			return format[:i] + arg + format[i+2:]
		}
	}
	return format
}

func TestResolveHolderBlackRockAnnexure(t *testing.T) {
	b, err := os.ReadFile(filepath.Join("testdata", "notices", "fmg_605_blackrock_annexure_only.txt"))
	if err != nil {
		t.Fatal(err)
	}
	n, _, _ := parseSubstantialNotice(string(b), "Ceasing to be a substantial holder")
	h, ok := resolveHolder(n, string(b), nil)
	if !ok || h.InstitutionSlug != "blackrock" {
		t.Fatalf("holder %+v ok=%v, want blackrock", h, ok)
	}
	// A notice naming two institutions about as often names neither.
	if inst := dominantInstitution("Mitsubishi UFJ Financial Group via Morgan Stanley; Mitsubishi UFJ Financial Group and Morgan Stanley; Morgan Stanley and Mitsubishi UFJ Financial Group"); inst != nil {
		t.Errorf("dominantInstitution = %s, want none", inst.Slug)
	}
}
