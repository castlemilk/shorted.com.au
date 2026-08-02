package influence

// The AEC funding layer — `shorted influence -mode aec-donations`.
//
// This is a SEPARATE path from -mode aec. That mode projects a couple of the
// annual CSVs into the industry-intelligence evidence feed and is untouched by
// this file; this one loads the funding corpus itself into the `aec_*` tables
// behind /politicians/donations. Both read the same exports through the shared
// primitives in aec_shared.go.
//
// Editorial frame (docs/feature/politicians/donations.md §2), because it
// constrains the parsing rather than just the rendering:
//
//   - Amounts ARE publishable here. AEC bulk data is CC BY 4.0, unlike the
//     register of interests, which carries no magnitude at all.
//   - The data is RIGHT-CENSORED at each year's disclosure threshold. A low
//     declared total is a disclosure fact, not a funding fact, and nothing in
//     the pipeline may present it otherwise.
//   - Names are stored VERBATIM alongside their normalised form. The normalised
//     value is a join key, never a display string.
//   - Byte-identical rows are counted, not deduplicated.
//   - Attribution honesty: a donation to a party is never a donation to a
//     member. Only returns that NAME a member reach a member surface, and a
//     name that does not resolve to exactly one politician resolves to nobody.
//
// The member layer is THIN by construction: 52 MP returns across ~16 members
// from FY2020-21, and 11,012 of 16,197 candidate returns are nil. Numbers this
// pipeline produces are only honest beside their coverage.

import (
	"context"
	"fmt"
	"io"
	"strings"
	"time"
)

// ---------------------------------------------------------------------------
// Row types. Every one carries the verbatim source string and, where it is a
// join key, its normalised form beside it.
// ---------------------------------------------------------------------------

type AECPartyReturn struct {
	FinancialYear      string
	FinancialYearEnd   int
	PartyName          string
	PartyNameNorm      string
	PartyGroup         string
	PartyGroupKey      string
	ReceiptsCents      int64
	PaymentsCents      int64
	DebtsCents         int64
	DiscretionaryCents int64
	Occurrence         int
}

type AECReceiptRecord struct {
	FinancialYear     string
	FinancialYearEnd  int
	ReturnType        string
	RecipientName     string
	RecipientNameNorm string
	ReceivedFrom      string
	ReceivedFromNorm  string
	ReceiptType       string
	AmountCents       int64
	Occurrence        int
}

type AECDonationMade struct {
	FinancialYear    string
	FinancialYearEnd int
	DonorName        string
	DonorNameNorm    string
	MadeTo           string
	MadeToNorm       string
	DonationDate     *time.Time
	AmountCents      int64
	Occurrence       int
}

type AECMPReturn struct {
	FinancialYear    string
	FinancialYearEnd int
	ReturnType       string
	Chamber          string
	MemberName       string
	MemberNameNorm   string
	Surname          string
	GivenNames       string
	TotalCents       int64
	DonorCount       int
}

type AECCandidateReturn struct {
	Event              string
	EventYear          *int
	EventParliament    *int
	ReturnType         string
	CandidateName      string
	Surname            string
	GivenNames         string
	PartyID            string
	PartyName          string
	ElectorateName     string
	ElectorateState    string
	NilReturn          bool
	AmendmentNo        int
	TotalGiftCents     int64
	DonorCount         int
	ExpenditureCents   int64
	DiscretionaryCents int64
}

type AECCandidateDonation struct {
	Event         string
	EventYear     *int
	ReturnType    string
	CandidateName string
	DonorName     string
	DonorNameNorm string
	DonationDate  *time.Time
	AmountCents   int64
	Occurrence    int
}

// AECDonationsCorpus is one complete snapshot of the three bulk exports.
type AECDonationsCorpus struct {
	PartyReturns       []AECPartyReturn
	Receipts           []AECReceiptRecord
	DonationsMade      []AECDonationMade
	MPReturns          []AECMPReturn
	CandidateReturns   []AECCandidateReturn
	CandidateDonations []AECCandidateDonation

	AnnualSourceURL     string
	ElectionsSourceURL  string
	ReferendumSourceURL string
	SnapshotAt          time.Time

	// MemberRowCounts is every CSV member of every archive with its parsed row
	// count, including the series we deliberately do NOT store: the dead
	// 2001/2004 media files and the whole referendum corpus, which v1 parses and
	// counts only. Counting them is how we notice the AEC changing a file we
	// have decided not to use yet.
	MemberRowCounts map[string]int
}

// ---------------------------------------------------------------------------
// Ingest
// ---------------------------------------------------------------------------

// ingestAECDonations loads all three exports. With AEC_SNAPSHOT_DIR set it reads
// a local corpus and never touches the AEC.
func ingestAECDonations(ctx context.Context) (*AECDonationsCorpus, error) {
	corpus := &AECDonationsCorpus{
		AnnualSourceURL:     aecAllAnnualDataURL,
		ElectionsSourceURL:  aecAllElectionsDataURL,
		ReferendumSourceURL: aecAllReferendumDataURL,
		SnapshotAt:          time.Now().UTC(),
		MemberRowCounts:     map[string]int{},
	}

	annual, err := fetchAECArchive(ctx, aecAllAnnualDataURL)
	if err != nil {
		return nil, err
	}
	if err := corpus.loadAnnual(annual); err != nil {
		return nil, err
	}

	elections, err := fetchAECArchive(ctx, aecAllElectionsDataURL)
	if err != nil {
		return nil, err
	}
	if err := corpus.loadElections(elections); err != nil {
		return nil, err
	}

	// The referendum export is parsed and COUNTED ONLY in v1. It is a distinct
	// disclosure regime (a referendum entity is not a party and not a
	// candidate), and folding it into party funding would misattribute it.
	referendum, err := fetchAECArchive(ctx, aecAllReferendumDataURL)
	if err != nil {
		return nil, err
	}
	corpus.countMembers(referendum)

	return corpus, nil
}

func (c *AECDonationsCorpus) loadAnnual(archive *aecArchive) error {
	c.countMembers(archive)

	if data, ok := archive.member("party returns.csv"); ok {
		rows, err := parseAECPartyReturnsCSV(data)
		if err != nil {
			return fmt.Errorf("parse Party Returns.csv: %w", err)
		}
		c.PartyReturns = rows
	} else {
		return fmt.Errorf("Party Returns.csv missing from %s", archive.Name)
	}

	if data, ok := archive.member("detailed receipts.csv"); ok {
		rows, err := parseAECReceiptsCSV(data)
		if err != nil {
			return fmt.Errorf("parse Detailed Receipts.csv: %w", err)
		}
		c.Receipts = rows
	} else {
		return fmt.Errorf("Detailed Receipts.csv missing from %s", archive.Name)
	}

	if data, ok := archive.member("donations made.csv"); ok {
		rows, err := parseAECDonationsMadeRecordsCSV(data)
		if err != nil {
			return fmt.Errorf("parse Donations Made.csv: %w", err)
		}
		c.DonationsMade = rows
	} else {
		return fmt.Errorf("Donations Made.csv missing from %s", archive.Name)
	}

	if data, ok := archive.member("memberofparliamentreturns.csv"); ok {
		rows, err := parseAECMPReturnsCSV(data)
		if err != nil {
			return fmt.Errorf("parse MemberOfParliamentReturns.csv: %w", err)
		}
		c.MPReturns = rows
	} else {
		return fmt.Errorf("MemberOfParliamentReturns.csv missing from %s", archive.Name)
	}
	return nil
}

func (c *AECDonationsCorpus) loadElections(archive *aecArchive) error {
	c.countMembers(archive)

	if data, ok := archive.member("candidate return summary.csv"); ok {
		rows, err := parseAECCandidateReturnsCSV(data)
		if err != nil {
			return fmt.Errorf("parse candidate return summary: %w", err)
		}
		c.CandidateReturns = rows
	} else {
		return fmt.Errorf("candidate return summary missing from %s", archive.Name)
	}

	if data, ok := archive.member("candidate donations.csv"); ok {
		rows, err := parseAECCandidateDonationsCSV(data)
		if err != nil {
			return fmt.Errorf("parse candidate donations: %w", err)
		}
		c.CandidateDonations = rows
	} else {
		return fmt.Errorf("candidate donations missing from %s", archive.Name)
	}
	return nil
}

// countMembers records the data-row count of every CSV in an archive, stored or
// not. Cheap, and it is the only way an unused-but-watched series (the dead
// 2001/2004 media files) tells us it has changed shape.
func (c *AECDonationsCorpus) countMembers(archive *aecArchive) {
	for name, data := range archive.Files {
		n, err := countAECDataRows(data)
		if err != nil {
			// A member we do not parse must never sink a run; record it as
			// uncounted rather than guessing a number.
			c.MemberRowCounts[archive.Name+"/"+name] = -1
			continue
		}
		c.MemberRowCounts[archive.Name+"/"+name] = n
	}
}

func countAECDataRows(data []byte) (int, error) {
	reader := newAECCSVReader(data)
	if _, err := reader.Read(); err != nil {
		if err == io.EOF {
			return 0, nil
		}
		return 0, err
	}
	n := 0
	for {
		if _, err := reader.Read(); err != nil {
			if err == io.EOF {
				return n, nil
			}
			return n, err
		}
		n++
	}
}

// ---------------------------------------------------------------------------
// Parsers
//
// Each one counts OCCURRENCES over exactly the tuple its table's natural key
// uses, so identical source rows survive the load instead of colliding.
// ---------------------------------------------------------------------------

// parseAECPartyReturnsCSV reads "Party Returns.csv":
// Financial Year, Name, Party Group, Total Receipts, Total Payments,
// Total Debts, Total Discretionary Benefits.
//
// (Financial Year, Name) is NOT unique — separate state branches lodge under one
// identical registered name (eleven FY/name pairs, up to six returns each), so
// the occurrence counter runs over the whole tuple including the totals.
func parseAECPartyReturnsCSV(data []byte) ([]AECPartyReturn, error) {
	reader := newAECCSVReader(data)
	headers, err := reader.Read()
	if err != nil {
		return nil, fmt.Errorf("read header: %w", err)
	}
	idxFY := columnIndex(headers, "Financial Year")
	idxName := columnIndex(headers, "Name")
	idxGroup := columnIndex(headers, "Party Group")
	idxReceipts := columnIndex(headers, "Total Receipts")
	idxPayments := columnIndex(headers, "Total Payments")
	idxDebts := columnIndex(headers, "Total Debts")
	idxDiscretionary := columnIndex(headers, "Total Discretionary Benefits")
	if idxFY < 0 || idxName < 0 {
		return nil, fmt.Errorf("missing required columns")
	}

	occurrences := map[string]int{}
	var out []AECPartyReturn
	for {
		row, err := reader.Read()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("read row: %w", err)
		}
		fy := readAECColumn(row, idxFY)
		yearEnd, ok := parseAECFinancialYear(fy)
		name := readAECColumn(row, idxName)
		if !ok || name == "" {
			continue
		}
		group := readAECColumn(row, idxGroup)
		receipts, _ := parseAECAmountCents(readAECColumn(row, idxReceipts))
		payments, _ := parseAECAmountCents(readAECColumn(row, idxPayments))
		debts, _ := parseAECAmountCents(readAECColumn(row, idxDebts))
		discretionary, _ := parseAECAmountCents(readAECColumn(row, idxDiscretionary))

		key := strings.Join([]string{
			fy, name,
			fmt.Sprint(receipts), fmt.Sprint(payments),
			fmt.Sprint(debts), fmt.Sprint(discretionary),
		}, "\x00")
		occurrences[key]++

		// A blank Party Group means the party IS its own group; falling back to
		// the party name keeps it in the rollup instead of pooling 959 rows
		// under an empty key.
		groupKey := group
		if groupKey == "" {
			groupKey = name
		}
		out = append(out, AECPartyReturn{
			FinancialYear:      fy,
			FinancialYearEnd:   yearEnd,
			PartyName:          name,
			PartyNameNorm:      normalizeAECEntityName(name),
			PartyGroup:         group,
			PartyGroupKey:      groupKey,
			ReceiptsCents:      receipts,
			PaymentsCents:      payments,
			DebtsCents:         debts,
			DiscretionaryCents: discretionary,
			Occurrence:         occurrences[key],
		})
	}
	return out, nil
}

// parseAECReceiptsCSV reads "Detailed Receipts.csv":
// Financial Year, Return Type, Recipient Name, Received From, Receipt Type, Value.
//
// Unlike the industry-evidence path, rows with a zero or negative value are
// KEPT: this table is the funding record, and a declared nil or corrected
// receipt is a fact about the return.
func parseAECReceiptsCSV(data []byte) ([]AECReceiptRecord, error) {
	reader := newAECCSVReader(data)
	headers, err := reader.Read()
	if err != nil {
		return nil, fmt.Errorf("read header: %w", err)
	}
	idxFY := columnIndex(headers, "Financial Year")
	idxReturnType := columnIndex(headers, "Return Type")
	idxRecipient := columnIndex(headers, "Recipient Name")
	idxFrom := columnIndex(headers, "Received From")
	idxReceiptType := columnIndex(headers, "Receipt Type")
	idxValue := columnIndex(headers, "Value")
	if idxFY < 0 || idxRecipient < 0 || idxFrom < 0 || idxValue < 0 {
		return nil, fmt.Errorf("missing required columns")
	}

	occurrences := map[string]int{}
	var out []AECReceiptRecord
	for {
		row, err := reader.Read()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("read row: %w", err)
		}
		fy := readAECColumn(row, idxFY)
		yearEnd, ok := parseAECFinancialYear(fy)
		if !ok {
			continue
		}
		returnType := readAECColumn(row, idxReturnType)
		recipient := readAECColumn(row, idxRecipient)
		from := readAECColumn(row, idxFrom)
		receiptType := readAECColumn(row, idxReceiptType)
		amount, okAmount := parseAECAmountCents(readAECColumn(row, idxValue))
		if !okAmount || recipient == "" || from == "" {
			continue
		}
		key := strings.Join([]string{fy, returnType, recipient, from, receiptType, fmt.Sprint(amount)}, "\x00")
		occurrences[key]++
		out = append(out, AECReceiptRecord{
			FinancialYear:     fy,
			FinancialYearEnd:  yearEnd,
			ReturnType:        returnType,
			RecipientName:     recipient,
			RecipientNameNorm: normalizeAECEntityName(recipient),
			ReceivedFrom:      from,
			ReceivedFromNorm:  normalizeAECEntityName(from),
			ReceiptType:       receiptType,
			AmountCents:       amount,
			Occurrence:        occurrences[key],
		})
	}
	return out, nil
}

// parseAECDonationsMadeRecordsCSV reads "Donations Made.csv":
// Financial Year, Donor Name, Donation Made To, Date, Value.
func parseAECDonationsMadeRecordsCSV(data []byte) ([]AECDonationMade, error) {
	reader := newAECCSVReader(data)
	headers, err := reader.Read()
	if err != nil {
		return nil, fmt.Errorf("read header: %w", err)
	}
	idxFY := columnIndex(headers, "Financial Year")
	idxDonor := columnIndex(headers, "Donor Name")
	idxTo := columnIndex(headers, "Donation Made To")
	idxDate := columnIndex(headers, "Date")
	idxValue := columnIndex(headers, "Value")
	if idxFY < 0 || idxDonor < 0 || idxTo < 0 || idxValue < 0 {
		return nil, fmt.Errorf("missing required columns")
	}

	occurrences := map[string]int{}
	var out []AECDonationMade
	for {
		row, err := reader.Read()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("read row: %w", err)
		}
		fy := readAECColumn(row, idxFY)
		yearEnd, ok := parseAECFinancialYear(fy)
		if !ok {
			continue
		}
		donor := readAECColumn(row, idxDonor)
		to := readAECColumn(row, idxTo)
		date := parseAECDate(readAECColumn(row, idxDate))
		amount, okAmount := parseAECAmountCents(readAECColumn(row, idxValue))
		if !okAmount || donor == "" {
			continue
		}
		dateKey := ""
		if date != nil {
			dateKey = date.Format("2006-01-02")
		}
		key := strings.Join([]string{fy, donor, to, dateKey, fmt.Sprint(amount)}, "\x00")
		occurrences[key]++
		out = append(out, AECDonationMade{
			FinancialYear:    fy,
			FinancialYearEnd: yearEnd,
			DonorName:        donor,
			DonorNameNorm:    normalizeAECEntityName(donor),
			MadeTo:           to,
			MadeToNorm:       normalizeAECEntityName(to),
			DonationDate:     date,
			AmountCents:      amount,
			Occurrence:       occurrences[key],
		})
	}
	return out, nil
}

// parseAECMPReturnsCSV reads "MemberOfParliamentReturns.csv":
// Financial Year, Return Type, Name, Total Donations Received, Number of Donors.
func parseAECMPReturnsCSV(data []byte) ([]AECMPReturn, error) {
	reader := newAECCSVReader(data)
	headers, err := reader.Read()
	if err != nil {
		return nil, fmt.Errorf("read header: %w", err)
	}
	idxFY := columnIndex(headers, "Financial Year")
	idxReturnType := columnIndex(headers, "Return Type")
	idxName := columnIndex(headers, "Name")
	idxTotal := columnIndex(headers, "Total Donations Received")
	idxDonors := columnIndex(headers, "Number of Donors")
	if idxFY < 0 || idxName < 0 {
		return nil, fmt.Errorf("missing required columns")
	}

	var out []AECMPReturn
	for {
		row, err := reader.Read()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("read row: %w", err)
		}
		fy := readAECColumn(row, idxFY)
		yearEnd, ok := parseAECFinancialYear(fy)
		name := readAECColumn(row, idxName)
		if !ok || name == "" {
			continue
		}
		returnType := readAECColumn(row, idxReturnType)
		total, _ := parseAECAmountCents(readAECColumn(row, idxTotal))
		donors, _ := parseAmount(readAECColumn(row, idxDonors))
		given, surname := splitAECMemberName(name)
		out = append(out, AECMPReturn{
			FinancialYear:    fy,
			FinancialYearEnd: yearEnd,
			ReturnType:       returnType,
			Chamber:          aecChamberFromReturnType(returnType),
			MemberName:       name,
			MemberNameNorm:   normalizeAECEntityName(stripAECHonorifics(name)),
			Surname:          surname,
			GivenNames:       given,
			TotalCents:       total,
			DonorCount:       int(donors),
		})
	}
	return out, nil
}

func aecChamberFromReturnType(returnType string) string {
	lower := strings.ToLower(returnType)
	switch {
	case strings.Contains(lower, "senator"):
		return "senate"
	case strings.Contains(lower, "house of representatives"):
		return "house"
	default:
		return "unknown"
	}
}

// aecHonorifics are the leading titles the AEC prefixes to a member's name, and
// aecPostNominals the awards and chamber suffixes it appends. Both lists are
// EXACT tokens: stripping by pattern would eat a real name ("Hon" is a token,
// "Honeywood" is a surname).
var aecHonorifics = map[string]bool{
	"SENATOR": true, "THE": true, "HON": true, "HON.": true, "RT": true,
	"DR": true, "DR.": true, "MR": true, "MR.": true, "MS": true, "MS.": true,
	"MRS": true, "MRS.": true, "MISS": true, "PROF": true, "PROFESSOR": true,
}

var aecPostNominals = map[string]bool{
	"MP": true, "OAM": true, "AM": true, "AO": true, "AC": true, "AK": true,
	"MBE": true, "OBE": true, "CBE": true, "KBE": true, "QC": true, "KC": true,
	"SC": true, "PSM": true, "CSC": true, "DSM": true, "APM": true, "AFC": true,
	"MC": true, "DSC": true, "ED": true, "JP": true, "RFD": true, "NEE": true,
}

// stripAECHonorifics reduces "Senator the Hon Anthony Chisholm" to
// "Anthony Chisholm" and "Ms Zali Steggall OAM MP" to "Zali Steggall".
func stripAECHonorifics(name string) string {
	fields := strings.Fields(cleanAECText(name))
	for len(fields) > 0 && aecHonorifics[strings.ToUpper(fields[0])] {
		fields = fields[1:]
	}
	for len(fields) > 0 && aecPostNominals[strings.ToUpper(strings.TrimSuffix(fields[len(fields)-1], "."))] {
		fields = fields[:len(fields)-1]
	}
	return strings.Join(fields, " ")
}

// splitAECMemberName returns (given names, surname) from an honorific-wrapped
// member name. The LAST remaining token is the surname; a one-token remainder
// yields no given name at all, which makes it unresolvable rather than a guess.
func splitAECMemberName(name string) (given, surname string) {
	fields := strings.Fields(stripAECHonorifics(name))
	if len(fields) == 0 {
		return "", ""
	}
	if len(fields) == 1 {
		return "", fields[0]
	}
	return strings.Join(fields[:len(fields)-1], " "), fields[len(fields)-1]
}

// splitAECCandidateName parses the election files' "SURNAME, Given Names" form.
// Without the comma the shape is unknown, so it withholds rather than guessing
// which token is the surname.
func splitAECCandidateName(name string) (given, surname string) {
	name = cleanAECText(name)
	surnamePart, givenPart, found := strings.Cut(name, ",")
	if !found {
		return "", ""
	}
	return strings.TrimSpace(givenPart), strings.TrimSpace(surnamePart)
}

// aecEventParliaments maps a general-election event to the parliament it
// elected. BY-ELECTIONS ARE DELIBERATELY ABSENT: dating one to a parliament
// needs a sitting calendar this pipeline does not have, and a wrong parliament
// would attribute a return to whoever else held the seat. They resolve to
// nobody, which is the correct v1 outcome.
var aecEventParliaments = map[string]int{
	"1996 FEDERAL ELECTION": 38,
	"1998 FEDERAL ELECTION": 39,
	"2001 FEDERAL ELECTION": 40,
	"2004 FEDERAL ELECTION": 41,
	"2007 FEDERAL ELECTION": 42,
	"2010 FEDERAL ELECTION": 43,
	"2013 FEDERAL ELECTION": 44,
	"2016 FEDERAL ELECTION": 45,
	"2019 FEDERAL ELECTION": 46,
	"2022 FEDERAL ELECTION": 47,
	"2025 FEDERAL ELECTION": 48,
}

// aecEventParliament resolves an event label to its parliament. The source
// capitalises inconsistently ("2013 Federal election" vs "2025 Federal
// Election"), so the lookup is case-insensitive.
func aecEventParliament(event string) *int {
	if p, ok := aecEventParliaments[strings.ToUpper(cleanAECText(event))]; ok {
		return &p
	}
	return nil
}

// aecEventYear reads the leading 4-digit year from an event label, when it has
// one. By-elections do not, and get no year.
func aecEventYear(event string) *int {
	m := aecYearStartRe.FindStringSubmatch(cleanAECText(event))
	if m == nil {
		return nil
	}
	var year int
	if _, err := fmt.Sscanf(m[1], "%d", &year); err != nil {
		return nil
	}
	if year < 1900 || year > 2200 {
		return nil
	}
	return &year
}

// parseAECCandidateReturnsCSV reads "Senate Groups and Candidate Return Summary.csv".
// Nil returns are KEPT: "lodged a nil return for the 2025 election" is a
// publishable fact, and dropping them would leave a member page silently blank
// where the member actually declared nothing.
func parseAECCandidateReturnsCSV(data []byte) ([]AECCandidateReturn, error) {
	reader := newAECCSVReader(data)
	headers, err := reader.Read()
	if err != nil {
		return nil, fmt.Errorf("read header: %w", err)
	}
	idxEvent := columnIndex(headers, "Event")
	idxReturnType := columnIndex(headers, "Return Type (Candidate/Senate Group)", "Return Type")
	idxName := columnIndex(headers, "Name")
	idxPartyID := columnIndex(headers, "Party ID")
	idxPartyName := columnIndex(headers, "Party Name")
	idxElectorate := columnIndex(headers, "Electorate Name")
	idxState := columnIndex(headers, "Electorate State")
	idxNil := columnIndex(headers, "Nil Return")
	idxAmendment := columnIndex(headers, "Amendment No")
	idxGift := columnIndex(headers, "Total Gift Value")
	idxDonors := columnIndex(headers, "Number Of Donors")
	idxExpenditure := columnIndex(headers, "Total Electoral Expenditure")
	idxDiscretionary := columnIndex(headers, "Discretionary Benefits Received")
	if idxEvent < 0 || idxName < 0 {
		return nil, fmt.Errorf("missing required columns")
	}

	var out []AECCandidateReturn
	for {
		row, err := reader.Read()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("read row: %w", err)
		}
		event := readAECColumn(row, idxEvent)
		name := readAECColumn(row, idxName)
		if event == "" || name == "" {
			continue
		}
		given, surname := splitAECCandidateName(name)
		gift, _ := parseAECAmountCents(readAECColumn(row, idxGift))
		expenditure, _ := parseAECAmountCents(readAECColumn(row, idxExpenditure))
		discretionary, _ := parseAECAmountCents(readAECColumn(row, idxDiscretionary))
		donors, _ := parseAmount(readAECColumn(row, idxDonors))
		amendment, _ := parseAmount(readAECColumn(row, idxAmendment))
		out = append(out, AECCandidateReturn{
			Event:              event,
			EventYear:          aecEventYear(event),
			EventParliament:    aecEventParliament(event),
			ReturnType:         readAECColumn(row, idxReturnType),
			CandidateName:      name,
			Surname:            surname,
			GivenNames:         given,
			PartyID:            readAECColumn(row, idxPartyID),
			PartyName:          readAECColumn(row, idxPartyName),
			ElectorateName:     readAECColumn(row, idxElectorate),
			ElectorateState:    readAECColumn(row, idxState),
			NilReturn:          strings.EqualFold(readAECColumn(row, idxNil), "Y"),
			AmendmentNo:        int(amendment),
			TotalGiftCents:     gift,
			DonorCount:         int(donors),
			ExpenditureCents:   expenditure,
			DiscretionaryCents: discretionary,
		})
	}
	return out, nil
}

// parseAECCandidateDonationsCSV reads "Senate Groups and Candidate Donations.csv".
// Two rows in the current export are negative (refunds/corrections) and are
// preserved as declared.
func parseAECCandidateDonationsCSV(data []byte) ([]AECCandidateDonation, error) {
	reader := newAECCSVReader(data)
	headers, err := reader.Read()
	if err != nil {
		return nil, fmt.Errorf("read header: %w", err)
	}
	idxEvent := columnIndex(headers, "Event")
	idxReturnType := columnIndex(headers, "Return Type (Candidate/Senate Group)", "Return Type")
	idxName := columnIndex(headers, "Name")
	idxDonor := columnIndex(headers, "Donor Name")
	idxDate := columnIndex(headers, "Date Of Gift")
	idxValue := columnIndex(headers, "Gift Value")
	if idxEvent < 0 || idxName < 0 || idxDonor < 0 || idxValue < 0 {
		return nil, fmt.Errorf("missing required columns")
	}

	occurrences := map[string]int{}
	var out []AECCandidateDonation
	for {
		row, err := reader.Read()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("read row: %w", err)
		}
		event := readAECColumn(row, idxEvent)
		name := readAECColumn(row, idxName)
		donor := readAECColumn(row, idxDonor)
		amount, okAmount := parseAECAmountCents(readAECColumn(row, idxValue))
		if event == "" || name == "" || donor == "" || !okAmount {
			continue
		}
		returnType := readAECColumn(row, idxReturnType)
		date := parseAECDate(readAECColumn(row, idxDate))
		dateKey := ""
		if date != nil {
			dateKey = date.Format("2006-01-02")
		}
		key := strings.Join([]string{event, returnType, name, donor, dateKey, fmt.Sprint(amount)}, "\x00")
		occurrences[key]++
		out = append(out, AECCandidateDonation{
			Event:         event,
			EventYear:     aecEventYear(event),
			ReturnType:    returnType,
			CandidateName: name,
			DonorName:     donor,
			DonorNameNorm: normalizeAECEntityName(donor),
			DonationDate:  date,
			AmountCents:   amount,
			Occurrence:    occurrences[key],
		})
	}
	return out, nil
}
