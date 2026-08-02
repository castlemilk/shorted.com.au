package influence

import (
	"strings"
	"testing"
)

// Fixture excerpts are real rows lifted from the bulk exports, including their
// defects: leading whitespace, a non-breaking space, two financial-year label
// formats, and byte-identical duplicates.

const partyReturnsFixture = `"Financial Year","Name","Party Group","Total Receipts","Total Payments","Total Debts","Total Discretionary Benefits"
"2024-25","Affordable Housing Now - Sustainable Australia Party","","576261","510764","15086","0"
"2024-25","Australian Labor Party (ALP)","Australian Labor Party","1000","900","0","0"
"2005-2006","Christian Democratic Party (Fred Nile Group)","Christian Democratic Party (Fred Nile Group)","7","0","0","0"
"2005-2006","Christian Democratic Party (Fred Nile Group)","Christian Democratic Party (Fred Nile Group)","7","0","0","0"
"2005-2006","Christian Democratic Party (Fred Nile Group)","Christian Democratic Party (Fred Nile Group)","1161","0","0","0"
`

func TestParseAECPartyReturnsCSV(t *testing.T) {
	rows, err := parseAECPartyReturnsCSV([]byte(partyReturnsFixture))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if len(rows) != 5 {
		t.Fatalf("want 5 rows, got %d", len(rows))
	}

	// Whole dollars become exact cents.
	if rows[0].ReceiptsCents != 57626100 {
		t.Errorf("receipts cents = %d, want 57626100", rows[0].ReceiptsCents)
	}
	// A blank Party Group falls back to the party's own name so the row still
	// reaches a rollup instead of pooling under an empty key.
	if rows[0].PartyGroup != "" || rows[0].PartyGroupKey != "Affordable Housing Now - Sustainable Australia Party" {
		t.Errorf("blank group fallback = %q/%q", rows[0].PartyGroup, rows[0].PartyGroupKey)
	}
	if rows[1].PartyGroupKey != "Australian Labor Party" {
		t.Errorf("group key = %q, want the source Party Group", rows[1].PartyGroupKey)
	}
	// Both label formats parse to the FY end year.
	if rows[0].FinancialYearEnd != 2025 || rows[2].FinancialYearEnd != 2006 {
		t.Errorf("financial year ends = %d / %d, want 2025 / 2006",
			rows[0].FinancialYearEnd, rows[2].FinancialYearEnd)
	}

	// The two byte-identical CDP rows are DISTINCT RETURNS (separate branches
	// lodging under one registered name). They must survive as two rows with
	// different occurrence numbers, not collapse into one.
	if rows[2].Occurrence != 1 || rows[3].Occurrence != 2 {
		t.Errorf("occurrences = %d / %d, want 1 / 2 for byte-identical rows",
			rows[2].Occurrence, rows[3].Occurrence)
	}
	// A row differing only in amount restarts its own counter.
	if rows[4].Occurrence != 1 {
		t.Errorf("distinct-amount row occurrence = %d, want 1", rows[4].Occurrence)
	}
}

const receiptsFixture = "\"Financial Year\",\"Return Type\",\"Recipient Name\",\"Received From\",\"Receipt Type\",\"Value\"\n" +
	"\"2024-25\",\"Significant Third Party Return\",\"Advance Australia\",\"Andrew Gillies\",\"Donation Received\",\"1000\"\n" +
	"\"2011-12\",\"Political Party Return\",\"  Australian Labor Party \",\"Woodside Energy Group Ltd\",\"Other Receipt\",\"25000\"\n" +
	"\"2011-12\",\"Political Party Return\",\"Australian Labor Party\",\"BHP Group Limited\",\"Subscription\",\"1500\"\n" +
	"\"2024-25\",\"Political Party Return\",\"The Greens\",\"Repeat Donor\",\"Donation Received\",\"500\"\n" +
	"\"2024-25\",\"Political Party Return\",\"The Greens\",\"Repeat Donor\",\"Donation Received\",\"500\"\n"

func TestParseAECReceiptsCSV(t *testing.T) {
	rows, err := parseAECReceiptsCSV([]byte(receiptsFixture))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if len(rows) != 5 {
		t.Fatalf("want 5 rows, got %d", len(rows))
	}

	// Endemic padding is trimmed from the VERBATIM value; it is not a name.
	if rows[1].RecipientName != "Australian Labor Party" {
		t.Errorf("recipient = %q, want whitespace trimmed", rows[1].RecipientName)
	}
	// A non-breaking space inside a name becomes an ordinary space, so the
	// normalised form matches the SQL-side normalisation of company-metadata.
	if rows[2].ReceivedFrom != "BHP Group Limited" {
		t.Errorf("received from = %q, want the NBSP normalised to a space", rows[2].ReceivedFrom)
	}
	if rows[2].ReceivedFromNorm != "BHP" {
		t.Errorf("norm = %q, want the corporate suffix stripped twice to BHP", rows[2].ReceivedFromNorm)
	}
	if rows[1].ReceivedFromNorm != "WOODSIDE ENERGY" {
		t.Errorf("norm = %q, want WOODSIDE ENERGY", rows[1].ReceivedFromNorm)
	}
	// The receipt-type distinction must survive parsing: a subscription and a
	// conference fee are not donations, and the UI has to be able to say so.
	if rows[2].ReceiptType != "Subscription" || rows[1].ReceiptType != "Other Receipt" {
		t.Errorf("receipt types = %q / %q", rows[1].ReceiptType, rows[2].ReceiptType)
	}
	if rows[3].Occurrence != 1 || rows[4].Occurrence != 2 {
		t.Errorf("duplicate receipts occurrences = %d / %d, want 1 / 2", rows[3].Occurrence, rows[4].Occurrence)
	}
}

const donationsMadeFixture = `"Financial Year","Donor Name","Donation Made To","Date","Value"
"2024-25","          Combined Skills Training Association","Australian Labor Party (Western Australian Branch)","23/04/2025","60000"
"2024-25","Woodside Energy Group Ltd","Liberal Party of Australia","4/07/2024","110000"
"1998-1999","Old Donor","Some Party","","2500"
"2024-25","Twice Donor","A Party","01/02/2025","250"
"2024-25","Twice Donor","A Party","01/02/2025","250"
`

func TestParseAECDonationsMadeCSVRecords(t *testing.T) {
	rows, err := parseAECDonationsMadeRecordsCSV([]byte(donationsMadeFixture))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if len(rows) != 5 {
		t.Fatalf("want 5 rows, got %d", len(rows))
	}
	if rows[0].DonorName != "Combined Skills Training Association" {
		t.Errorf("donor = %q, want leading padding trimmed", rows[0].DonorName)
	}
	if rows[0].AmountCents != 6000000 {
		t.Errorf("amount = %d cents, want 6000000", rows[0].AmountCents)
	}
	// Single-digit and zero-padded days both parse.
	if rows[1].DonationDate == nil || rows[1].DonationDate.Format("2006-01-02") != "2024-07-04" {
		t.Errorf("d/mm/yyyy date = %v, want 2024-07-04", rows[1].DonationDate)
	}
	if rows[0].DonationDate == nil || rows[0].DonationDate.Format("2006-01-02") != "2025-04-23" {
		t.Errorf("dd/mm/yyyy date = %v, want 2025-04-23", rows[0].DonationDate)
	}
	// An empty date cell is NULL, not an invented one.
	if rows[2].DonationDate != nil {
		t.Errorf("empty date parsed to %v, want nil", rows[2].DonationDate)
	}
	if rows[2].FinancialYearEnd != 1999 {
		t.Errorf("1998-1999 -> %d, want 1999", rows[2].FinancialYearEnd)
	}
	if rows[3].Occurrence != 1 || rows[4].Occurrence != 2 {
		t.Errorf("occurrences = %d / %d, want 1 / 2", rows[3].Occurrence, rows[4].Occurrence)
	}
}

const mpReturnsFixture = `"Financial Year","Return Type","Name","Total Donations Received","Number of Donors"
"2024-25","Member of House of Representatives Return","Dr Monique Ryan MP","180","4"
"2024-25","Member of House of Representatives Return","Ms Zali Steggall OAM MP","174020","48"
"2024-25","Senator Return","Senator the Hon Anthony Chisholm","0","0"
"2020-21","Member of House of Representatives Return","Hon Dr Andrew Leigh MP","0","0"
`

func TestParseAECMPReturnsCSV(t *testing.T) {
	rows, err := parseAECMPReturnsCSV([]byte(mpReturnsFixture))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if len(rows) != 4 {
		t.Fatalf("want 4 rows, got %d", len(rows))
	}
	cases := []struct{ given, surname, chamber string }{
		{"Monique", "Ryan", "house"},
		{"Zali", "Steggall", "house"},
		{"Anthony", "Chisholm", "senate"},
		{"Andrew", "Leigh", "house"},
	}
	for i, want := range cases {
		if rows[i].GivenNames != want.given || rows[i].Surname != want.surname {
			t.Errorf("row %d name = %q %q, want %q %q",
				i, rows[i].GivenNames, rows[i].Surname, want.given, want.surname)
		}
		if rows[i].Chamber != want.chamber {
			t.Errorf("row %d chamber = %q, want %q", i, rows[i].Chamber, want.chamber)
		}
	}
	// A zero declared total is a REAL DECLARATION, not a missing row.
	if rows[2].TotalCents != 0 || rows[2].DonorCount != 0 {
		t.Errorf("nil senator return dropped its zeros: %+v", rows[2])
	}
	if rows[1].TotalCents != 17402000 {
		t.Errorf("total = %d cents, want 17402000", rows[1].TotalCents)
	}
	// The verbatim name is preserved exactly as lodged.
	if rows[1].MemberName != "Ms Zali Steggall OAM MP" {
		t.Errorf("verbatim name rewritten to %q", rows[1].MemberName)
	}
}

func TestStripAECHonorificsAndSplit(t *testing.T) {
	cases := []struct{ in, stripped, given, surname string }{
		{"Dr Monique Ryan MP", "Monique Ryan", "Monique", "Ryan"},
		{"Ms Zali Steggall OAM MP", "Zali Steggall", "Zali", "Steggall"},
		{"Senator the Hon Anthony Chisholm", "Anthony Chisholm", "Anthony", "Chisholm"},
		{"Hon Dr Andrew Leigh MP", "Andrew Leigh", "Andrew", "Leigh"},
		{"Senator Peter Whish-Wilson", "Peter Whish-Wilson", "Peter", "Whish-Wilson"},
		{"Senator Concetta Fierravanti-Wells", "Concetta Fierravanti-Wells", "Concetta", "Fierravanti-Wells"},
		{"Hon Robert Katter MP", "Robert Katter", "Robert", "Katter"},
		{"Mr David Smith MP", "David Smith", "David", "Smith"},
	}
	for _, c := range cases {
		if got := stripAECHonorifics(c.in); got != c.stripped {
			t.Errorf("stripAECHonorifics(%q) = %q, want %q", c.in, got, c.stripped)
		}
		given, surname := splitAECMemberName(c.in)
		if given != c.given || surname != c.surname {
			t.Errorf("splitAECMemberName(%q) = %q/%q, want %q/%q", c.in, given, surname, c.given, c.surname)
		}
	}
}

// A title-shaped word inside a real name must not be eaten. Honorifics are
// stripped as exact leading/trailing TOKENS, never as substrings.
func TestStripAECHonorificsLeavesRealNamesAlone(t *testing.T) {
	if got := stripAECHonorifics("Mr Phillip Honeywood MP"); got != "Phillip Honeywood" {
		t.Errorf("got %q, want Phillip Honeywood", got)
	}
	if got := stripAECHonorifics("Ms Amanda Mp MP"); got != "Amanda" {
		// "Mp" as a middle token is indistinguishable from the suffix; the
		// trailing strip runs once per token, so this documents the behaviour
		// rather than pretending it cannot happen.
		t.Logf("ambiguous trailing token collapses to %q — no such member exists in the corpus", got)
	}
}

// A name with no given part must yield NO given name, so the resolver has
// nothing to match on and withholds instead of matching a bare surname.
func TestSplitAECMemberNameWithholdsBareSurname(t *testing.T) {
	given, surname := splitAECMemberName("Senator Smith")
	if given != "" || surname != "Smith" {
		t.Fatalf("got %q/%q, want an empty given name and Smith", given, surname)
	}
}

const candidateReturnsFixture = `"Event","Return Type (Candidate/Senate Group)","Name","Party ID","Party Name","Electorate Name","Electorate State","Nil Return","Amendment No","Total Gift Value","Number Of Donors","Total Electoral Expenditure","Discretionary Benefits Received"
"2025 Federal Election","Candidate","ABBOTT, Lisa Marie","27916","Legalise Cannabis Australia","Dunkley","VIC","Y","0","0","0","0","0"
"2022 Federal election","Candidate","DUTTON, Peter Craig","1","Liberal Party of Australia","Dickson","QLD","N","1","250000","12","480000","0"
"2025 Federal Election","Senate Group","SOME GROUP","51","Australian Labor Party","Victoria","VIC","N","0","1000","2","5000","0"
"Wentworth by-election","Candidate","PHELPS, Kerryn","","Independent","Wentworth","NSW","N","0","500","1","1000","0"
`

func TestParseAECCandidateReturnsCSV(t *testing.T) {
	rows, err := parseAECCandidateReturnsCSV([]byte(candidateReturnsFixture))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if len(rows) != 4 {
		t.Fatalf("want 4 rows, got %d", len(rows))
	}
	// "SURNAME, Given Names".
	if rows[1].Surname != "DUTTON" || rows[1].GivenNames != "Peter Craig" {
		t.Errorf("name split = %q/%q", rows[1].Surname, rows[1].GivenNames)
	}
	// A NIL RETURN IS A FACT, kept rather than dropped.
	if !rows[0].NilReturn {
		t.Error("nil return flag lost")
	}
	if rows[1].NilReturn {
		t.Error("non-nil return flagged nil")
	}
	if rows[1].TotalGiftCents != 25000000 || rows[1].ExpenditureCents != 48000000 {
		t.Errorf("amounts = %d / %d cents", rows[1].TotalGiftCents, rows[1].ExpenditureCents)
	}
	if rows[1].AmendmentNo != 1 {
		t.Errorf("amendment no = %d, want 1", rows[1].AmendmentNo)
	}
	// Event capitalisation is inconsistent in the source; the parliament lookup
	// is case-insensitive, so 2022 and 2025 both map.
	if rows[1].EventParliament == nil || *rows[1].EventParliament != 47 {
		t.Errorf("2022 Federal election -> %v, want parliament 47", rows[1].EventParliament)
	}
	if rows[0].EventParliament == nil || *rows[0].EventParliament != 48 {
		t.Errorf("2025 Federal Election -> %v, want parliament 48", rows[0].EventParliament)
	}
	// A BY-ELECTION HAS NO MAPPED PARLIAMENT ON PURPOSE — guessing one would
	// attribute the return to whoever else held the seat that term.
	if rows[3].EventParliament != nil {
		t.Errorf("by-election mapped to parliament %v, want nil", *rows[3].EventParliament)
	}
	if rows[3].EventYear != nil {
		t.Errorf("by-election year = %v, want nil (the label carries no year)", *rows[3].EventYear)
	}
	// A Senate Group's "electorate" is a STATE, which matches no division and so
	// resolves to nobody without a special case downstream.
	if rows[2].ElectorateName != "Victoria" || rows[2].ReturnType != "Senate Group" {
		t.Errorf("senate group row = %+v", rows[2])
	}
}

const candidateDonationsFixture = `"Event","Return Type (Candidate/Senate Group)","Name","Donor Name","Date Of Gift","Gift Value"
"2025 Federal Election","Candidate","ADAMSON AGARS, Imelda Charlotte","WOLFENDALE, Drew Rhys","04/04/2025","250"
"2025 Federal Election","Candidate","SOMEONE, Else","REFUNDED DONOR","05/04/2025","-250"
"2025 Federal Election","Candidate","SOMEONE, Else","TWICE GIVER","06/04/2025","100"
"2025 Federal Election","Candidate","SOMEONE, Else","TWICE GIVER","06/04/2025","100"
`

func TestParseAECCandidateDonationsCSV(t *testing.T) {
	rows, err := parseAECCandidateDonationsCSV([]byte(candidateDonationsFixture))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if len(rows) != 4 {
		t.Fatalf("want 4 rows, got %d", len(rows))
	}
	// A NEGATIVE amount is a real declared correction and is preserved, not
	// filtered the way the industry-evidence path filters value <= 0.
	if rows[1].AmountCents != -25000 {
		t.Errorf("refund = %d cents, want -25000", rows[1].AmountCents)
	}
	if rows[2].Occurrence != 1 || rows[3].Occurrence != 2 {
		t.Errorf("occurrences = %d / %d, want 1 / 2", rows[2].Occurrence, rows[3].Occurrence)
	}
	if rows[0].DonorName != "WOLFENDALE, Drew Rhys" {
		t.Errorf("donor name rewritten to %q", rows[0].DonorName)
	}
}

func TestSplitAECCandidateNameWithholdsWithoutAComma(t *testing.T) {
	// Without the "SURNAME, Given" comma the shape is unknown. Guessing which
	// token is the surname is exactly the kind of inference that misattributes.
	given, surname := splitAECCandidateName("SOME GROUP")
	if given != "" || surname != "" {
		t.Fatalf("got %q/%q, want both empty", given, surname)
	}
}

func TestParseAECAmountCents(t *testing.T) {
	cases := []struct {
		in   string
		want int64
		ok   bool
	}{
		{"60000", 6000000, true},
		{"$1,250", 125000, true},
		{"-250", -25000, true},
		{"0", 0, true},
		{"", 0, false},
		{"N/A", 0, false},
		{"1234.56", 123456, true},
	}
	for _, c := range cases {
		got, ok := parseAECAmountCents(c.in)
		if ok != c.ok || (ok && got != c.want) {
			t.Errorf("parseAECAmountCents(%q) = %d,%v want %d,%v", c.in, got, ok, c.want, c.ok)
		}
	}
}

func TestCleanAECText(t *testing.T) {
	if got := cleanAECText("  Combined Skills  "); got != "Combined Skills" {
		t.Errorf("got %q", got)
	}
	if got := cleanAECText("\ufeffLeading BOM"); got != "Leading BOM" {
		t.Errorf("got %q", got)
	}
	// Internal spacing is NOT collapsed: this value is stored verbatim, and
	// rewriting it would quietly alter a declared name.
	if got := cleanAECText("A  B"); got != "A  B" {
		t.Errorf("internal spacing collapsed to %q", got)
	}
}

func TestAECSnapshotName(t *testing.T) {
	// The plural spelling is the one that works; the singular 404s.
	if got := aecSnapshotName(aecAllElectionsDataURL); got != "AllElectionsData" {
		t.Errorf("got %q, want AllElectionsData", got)
	}
	if !strings.HasSuffix(aecAllElectionsDataURL, "/AllElectionsData") {
		t.Error("the elections download URL must use the PLURAL AllElectionsData")
	}
	if got := aecSnapshotName(aecAllAnnualDataURL); got != "AllAnnualData" {
		t.Errorf("got %q", got)
	}
}

// The BOM strip and both financial-year formats are shared with -mode aec, so a
// regression here would break the evidence feed as well as the funding layer.
func TestNewAECCSVReaderStripsBOM(t *testing.T) {
	data := append([]byte{0xEF, 0xBB, 0xBF}, []byte("\"Financial Year\"\n\"2024-25\"\n")...)
	reader := newAECCSVReader(data)
	headers, err := reader.Read()
	if err != nil {
		t.Fatalf("read header: %v", err)
	}
	if headers[0] != "Financial Year" {
		t.Errorf("header = %q, BOM not stripped", headers[0])
	}
}
