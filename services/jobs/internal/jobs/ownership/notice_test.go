package ownership

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
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

// The placeholder rule, on names as the pass judges them (tidied). Each case is
// either a placeholder or a name that passes through unchanged.
func TestPlaceholderReason(t *testing.T) {
	for _, tc := range []struct {
		name        string
		placeholder bool
	}{
		// Pointers to an annexure, to another page or to the schedule.
		{"SEE ANNEXURE 1", true},
		{"see annexure a", true},
		{"Refer to Annexure A", true},
		{"ANNEXURE1", true},
		{"Annexures", true},
		{"SEE ATTACHED", true},
		{"  see   Attached ", true},
		{"As above", true},
		{"As per", true},
		{"Not applicable", true},
		{"N/A", true},
		{"(N/A)", true},
		{"Schedule 1", true},
		{"SCHEDULE", true},
		{"Refer", true},
		{"NA", true},
		{"See Appendix A", true},
		{"See Annex A", true},
		{"See Annexe 1", true},
		{"See attachment 1", true},
		{"Refer attached", true},
		{"Per attached", true},
		{"Please see Schedule 1", true},
		{"Listed in Schedule 1", true},
		{"Details in Annexure 1", true},
		{"Holders listed in Annexure B", true},
		// Boilerplate with no holder named before it: the name was lost.
		{"AND ITS SUBSIDIARIES LISTED IN ANNEXURE A", true},
		// A text layer broke a word apart: "ANNEX URE", "a pp licable".
		{"SEE ANNEX URE 1", true},
		{"Not a pp licable", true},
		// A pointer that opens the name, with words after it.
		{"Refer to the holding statement", true},
		// No letter in it, or every word a single letter.
		{"123 456 789", true},
		{"-", true},
		{"--", true},
		{"(1)", true},
		{"A B", true},
		{"J.S.", true},
		// Holders, which pass unchanged.
		{"Mrs Georgina Hope Rinehart , Hancock Prospecting Pty Ltd", false},
		{"FMR LLC", false},
		{"Vanguard Group", false},
		{"Christmas Perry Holdings Pty Ltd", false}, // "as per" inside a word
		{"Scheduled Asset Management Limited", false},
		{"Schedule Capital Partners Pty Ltd", false}, // the word, but in more than three words
		{"Limite d", false},                          // a split key: not a placeholder, and not merged
		{"L1 Capital Pty Ltd", false},
		{"Ana", false},
		// A pointer word can open a company's name, so the rest of the name decides.
		{"Annexe Capital", false},
		{"Attached Capital Pty Ltd", false},
		// A pointer beside a name of its own is a clause about that name, whether
		// or not nameTails cut it.
		{"Citigroup Global Markets Australia Pty Limited, as listed in Annexure A", false},
		{"HSBC Holdings plc and its group companies listed in Annexure A", false},
		{"BlackRock Inc. - see Annexure A", false},
		{"Mitsubishi UFJ Financial Group, Inc. See Annexure A", false},
		{"L1 Capital Pty Ltd and the entities in Annexure A", false},
		{"Regal Partners Limited, together with its controlled entities listed in Annexure A", false},
		{"Tribeca Investment Partners Pty Ltd as per Annexure A", false},
		{"Acme Pty Ltd and its wholly owned subsidiaries listed in Annexure A", false},
		{"As trustee for Smith Family", false},
		// A word that only contains a pointer's letters is a name: "Jasper" is not
		// "as per", and "Prefer To" is not "refer to".
		{"Jasper Holdings Pty Ltd", false},
		{"Prefer To Invest Pty Ltd", false},
		{"N/AB Holdings", false},
		// "N/A" glued onto a real name by a text layer (the form's ACN column) is
		// still a name: the pointer rule needs a name with no word of its own.
		{"Hugh Warner N/A 25 / 03 / 2025", false},
		{"Mega Uranium Ltd and Mega Redport Pty Ltd who are each associates of each other - N/A", false},
		{"Name: N/A", true},
		{"Not applicable (N/A)", true},
		{"", false}, // no value was written: the fallbacks read the holder
	} {
		if got := placeholderReason(tc.name); (got != "") != tc.placeholder {
			t.Errorf("placeholderReason(%q) = %q, want placeholder %v", tc.name, got, tc.placeholder)
		}
	}
}

// A boilerplate tail is cut before the rule reads a name, so the annexure
// reference inside the tail does not withhold a holder the form names.
func TestPlaceholderJudgedAfterTidy(t *testing.T) {
	for _, raw := range []string{
		"Vanguard Group (The Vanguard Group, Inc. and its controlled entities including those listed in Annexure A)",
		"FMR LLC and its entities listed in Annexure A",
		"PINNACLE INVESTMENT MANAGEMENT GROUP LIMITED (AND ITS SUBSIDIARIES LISTED IN ANNEXURE A)",
	} {
		if got := placeholderReason(tidyHolderName(raw)); got != "" {
			t.Errorf("tidyHolderName(%q) = %q reads as a placeholder: %s", raw, tidyHolderName(raw), got)
		}
	}
}

// placeholderNotice is a synthetic 603 whose section 1 names holder as given.
// Its holding (6.0049%, the figure a placeholder row counted in SYR's sum)
// parses on its own, and its annexure names BlackRock's entities, so a holder
// read from the notice's text would show as BlackRock.
func placeholderNotice(holder string) string {
	return fmt.Sprintf("Form 603 Notice of initial substantial holder To Company Name/Scheme Example Resources Limited "+
		"1. Details of substantial holder (1) Name %s ACN/ARSN 2. Details of voting power Class Ordinary "+
		"62,856,312 6.0049%% 3. Changes in relevant interests %s Annexure A: BlackRock Advisors (UK) Limited; "+
		"BlackRock Investment Management (Australia) Limited; BlackRock Financial Management, Inc.", holder, padding)
}

// placeholderNZNotice is a synthetic NZ disclosure whose full name is holder.
func placeholderNZNotice(holder string) string {
	return fmt.Sprintf("Disclosure of movement of 1%% or more in substantial holding "+
		"Sections 277 and 278, Financial Markets Conduct Act 2013 To New Zealand Stock Exchange and To EXAMPLE LIMITED "+
		"Relevant event being disclosed: Disclosure of movement of 1%% or more in substantial holding "+
		"Substantial product holder(s) giving disclosure Full name(s): %s Summary of substantial holding "+
		"For this disclosure, - (a) total number held in class: 37,935,318 (b) total in class: 728,055,850 "+
		"(c) total percentage held in class: 5.21%% For last disclosure, - (a) total number held in class: 45,159,220 "+
		"(b) total in class: 725,426,194 (c) total percentage held in class: 6.23%% %s", holder, padding)
}

// A placeholder section 1 name withholds the notice as no_holder, and the
// detail names the text. Only the company is read from a withheld notice: no
// figure, and no holder from the annexure.
func TestPlaceholderHolderWithheld(t *testing.T) {
	for _, tc := range []struct {
		name    string
		text    string
		outcome Outcome
		detail  string
	}{
		{"a real name parses", placeholderNotice("Some Fund Pty Ltd"), outcomeParsed, ""},
		{"a clause after a real name", placeholderNotice("Citigroup Global Markets Australia Pty Limited, as listed in Annexure A"), outcomeParsed, ""},
		{"SEE ANNEXURE 1", placeholderNotice("SEE ANNEXURE 1"), outcomeNoHolder, `"SEE ANNEXURE 1" (matches "annexure")`},
		{"SEE ANNEX URE 1", placeholderNotice("SEE ANNEX URE 1"), outcomeNoHolder, `"SEE ANNEX URE 1" (matches "annexure")`},
		{"Refer to Annexure A", placeholderNotice("Refer to Annexure A"), outcomeNoHolder, `"Refer to Annexure A" (matches "annexure")`},
		{"N/A", placeholderNotice("N/A"), outcomeNoHolder, `"N/A" (matches "n/a")`},
		// The pointer sits in the tail that tidying cuts, so the rule reads the
		// pointer alone.
		{"a pointer behind a tail", placeholderNotice("SEE ANNEXURE 1 on behalf of Some Fund Pty Ltd"), outcomeNoHolder, `"SEE ANNEXURE 1" (matches "annexure")`},
		{"a dash", placeholderNotice("-"), outcomeNoHolder, `"-" (no letter in it)`},
		{"digits only", placeholderNotice("123 456 789"), outcomeNoHolder, `"123 456 789" (no letter in it)`},
		{"single letters", placeholderNotice("A B"), outcomeNoHolder, `"A B" (every word is a single letter)`},
		{"an NZ name parses", placeholderNZNotice("Some Fund Limited"), outcomeParsed, ""},
		{"an NZ pointer", placeholderNZNotice("SEE ATTACHED"), outcomeNoHolder, `"SEE ATTACHED" (matches "attached")`},
		{"an NZ institution clause parses", placeholderNZNotice("Refer Annexure A for Vanguard Group entities"), outcomeParsed, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			n, outcome, detail := parseSubstantialNotice(tc.text, "")
			if outcome != tc.outcome || !strings.Contains(detail, tc.detail) {
				t.Fatalf("outcome %s (%s), want %s (%s)", outcome, detail, tc.outcome, tc.detail)
			}
			if outcome == outcomeNoHolder && (n.HolderName != "" || n.PresentPct != nil || n.PresentVotes != nil) {
				t.Errorf("a withheld notice kept %+v", n)
			}
		})
	}
}

// A name that resolves to a curated institution is a holder whatever its opening
// words. The notice parses, the section 1 name is kept (the words named here are
// in the holder name the parser returns), and the institution is the one it
// names. This holds on both the Australian forms and the NZ disclosure. The
// words are checked, not the whole name: a text layer can glue a standalone "A"
// to the word after it, as cleanHolderName does to "A for".
func TestPlaceholderHolderResolvesToInstitution(t *testing.T) {
	for _, tc := range []struct {
		name, holder, slug string
	}{
		{"Annexure A: BlackRock Inc.", "BlackRock Inc", "blackrock"},
		{"Refer Annexure A for Vanguard Group entities", "Vanguard Group entities", "vanguard"},
		// The tail tidying cuts names BlackRock, and the rule still reads the name
		// as written.
		{"SEE ANNEXURE A (BlackRock Inc. and its subsidiaries)", "BlackRock Inc. and its subsidiaries", "blackrock"},
	} {
		for _, form := range []struct {
			label, text string
		}{
			{"603", placeholderNotice(tc.name)},
			{"nz", placeholderNZNotice(tc.name)},
		} {
			t.Run(tc.name+" "+form.label, func(t *testing.T) {
				n, outcome, detail := parseSubstantialNotice(form.text, "")
				if outcome != outcomeParsed {
					t.Fatalf("outcome %s (%s), want parsed", outcome, detail)
				}
				if !strings.Contains(n.HolderName, tc.holder) {
					t.Errorf("holder name %q, want it to keep %q", n.HolderName, tc.holder)
				}
				got := ""
				if inst := resolveInstitution(n.HolderName); inst != nil {
					got = inst.Slug
				}
				if got != tc.slug {
					t.Errorf("institution %q, want %q", got, tc.slug)
				}
			})
		}
	}
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
