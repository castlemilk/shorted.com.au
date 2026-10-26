package ownership

import (
	"context"
	"fmt"
	"regexp"
	"slices"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/castlemilk/shorted.com.au/services/pkg/extractiontrust"
)

// The notices pass. The announcements job stores every ASX announcement's
// headline and PDF link in asx_announcements; this pass selects the
// substantial holding notices among them, reads each PDF, and stores what it
// says. It mirrors the dividend notice pass (announcements/dividend_pass.go):
// one attempt per notice, a store error records nothing so the notice is
// retried, a dry run writes nothing.

// pendingNotice is one notice PDF to read. ASX lists a notice under every
// code it concerns: the company the holding is in and, when the holder is a
// listed company itself (CBA, MQG, MIN), the holder's code too.
type pendingNotice struct {
	URL         string
	Headline    string
	AnnouncedOn string
	ListedCodes []string
}

// company is what the pass knows about a listed code.
type company struct {
	Code string
	Name string
}

// noticeRow is one parsed notice as stored.
type noticeRow struct {
	URL             string
	StockCode       string
	Form            Form
	HolderName      string
	HolderKey       string
	InstitutionSlug string
	EventDate       string
	AnnouncedOn     string
	PreviousPct     *float64
	PresentPct      *float64
	PreviousVotes   *int64
	PresentVotes    *int64
	Ceased          bool
}

type noticeAttempt struct {
	URL       string
	StockCode string
	Outcome   string
	Detail    string
}

// noticeStore is the pass's database. An interface so the pass is testable
// without Postgres.
type noticeStore interface {
	PendingNotices(ctx context.Context, limit int, since string, parserVersion int) ([]pendingNotice, error)
	Companies(ctx context.Context) (map[string]company, error)
	SharesOnIssue(ctx context.Context, code, on string) (float64, error)
	UpsertNotice(ctx context.Context, row noticeRow) error
	RecordAttempt(ctx context.Context, a noticeAttempt, parserVersion int) error
}

// pdfSource downloads an announcement's PDF.
type pdfSource interface {
	PDF(ctx context.Context, url string) ([]byte, error)
}

// Outcomes the pass adds to the parser's.
const (
	outcomeFetchError        = "fetch_error"
	outcomeAmbiguousTarget   = "ambiguous_target"
	outcomeNoHolder          = "no_holder"
	outcomeInconsistentVotes = "inconsistent_votes"
)

var (
	headlineForRe  = regexp.MustCompile(`\b(?:for|in)\s+([A-Z0-9]{3,6})\s*$`)
	headlineFromRe = regexp.MustCompile(`\bfrom\s+([A-Z0-9]{2,6})\s*$`)
)

// resolveTarget decides which listed company a notice is about. ASX titles a
// notice lodged by a listed holder "... for CAR" (or "... in CAR") under the
// holder's code and "... from MQG" under the company's, and lists it under
// both. A headline naming a company not on record (delisted since, or taken
// over) is withheld: the code it is listed under is then the holder's.
func resolveTarget(p pendingNotice, docCompany string, companies map[string]company) (string, string) {
	codes := uniqueSorted(p.ListedCodes)
	if m := headlineForRe.FindStringSubmatch(strings.TrimSpace(p.Headline)); m != nil {
		if _, ok := companies[m[1]]; ok {
			return m[1], ""
		}
		if !slices.Contains(codes, m[1]) {
			return "", fmt.Sprintf("headline names %s, not a listed company on record; listed under %s", m[1], strings.Join(codes, ","))
		}
	}
	if len(codes) == 1 {
		return codes[0], ""
	}
	if docCompany != "" {
		var matched []string
		for _, c := range codes {
			if co, ok := companies[c]; ok && extractiontrust.EntityMatches(docCompany, co.Name) {
				matched = append(matched, c)
			}
		}
		if len(matched) == 1 {
			return matched[0], ""
		}
	}
	if m := headlineFromRe.FindStringSubmatch(strings.TrimSpace(p.Headline)); m != nil {
		var others []string
		for _, c := range codes {
			if c != m[1] {
				others = append(others, c)
			}
		}
		if len(others) == 1 && len(others) < len(codes) {
			return others[0], ""
		}
	}
	return "", fmt.Sprintf("listed under %s; the notice names %q", strings.Join(codes, ","), docCompany)
}

func uniqueSorted(in []string) []string {
	seen := map[string]bool{}
	var out []string
	for _, s := range in {
		s = strings.ToUpper(strings.TrimSpace(s))
		if s != "" && !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	sort.Strings(out)
	return out
}

// holderIdentity is who a notice's holder is.
type holderIdentity struct {
	Key             string
	InstitutionSlug string
	Name            string
}

// resolveHolder names the holder: a curated institution first (by its
// section 1 name, or, when that cannot be read, by the one institution named
// in section 1 at all), then a listed company whose name it exactly is, then
// the name itself.
func resolveHolder(n Notice, text string, companiesByKey map[string]string) (holderIdentity, bool) {
	name := tidyHolderName(n.HolderName)
	if inst := resolveInstitution(n.HolderName); inst != nil {
		if name == "" {
			name = inst.Name
		}
		return holderIdentity{Key: inst.Slug, InstitutionSlug: inst.Slug, Name: name}, true
	}
	if name == "" {
		if insts := institutionsInText(section1Text(text)); len(insts) == 1 {
			return holderIdentity{Key: insts[0].Slug, InstitutionSlug: insts[0].Slug, Name: insts[0].Name}, true
		}
		if inst := dominantInstitution(text); inst != nil {
			return holderIdentity{Key: inst.Slug, InstitutionSlug: inst.Slug, Name: inst.Name}, true
		}
		return holderIdentity{}, false
	}
	key := holderKey(name)
	if key == "" {
		return holderIdentity{}, false
	}
	if code, ok := companiesByKey[key]; ok {
		return holderIdentity{Key: "asx:" + code, Name: name}, true
	}
	return holderIdentity{Key: key, Name: name}, true
}

// relinkHolder re-decides a stored notice's holder after the registry or the
// name rules change. A name that now names an institution moves to it. A
// holder linked from the notice's text (an image-only section 1, whose name
// resolves to nothing) keeps its institution while that is on the map, and
// goes back to its name only when it leaves. An unmapped holder is re-keyed by
// its tidied name; a listed company's key (asx:CODE) stays.
func relinkHolder(name, key, slug string) (newName, newKey, newSlug string, changed bool) {
	newName, newKey, newSlug = name, key, slug
	if t := tidyHolderName(name); t != "" {
		newName = t
	}
	switch inst := resolveInstitution(name); {
	case inst != nil:
		newKey, newSlug = inst.Slug, inst.Slug
	case slug != "" && institutionBySlug(slug) != nil:
	case slug != "":
		if k := holderKey(name); k != "" {
			newKey, newSlug = k, ""
		}
	case strings.HasPrefix(key, "name:"):
		if k := holderKey(name); k != "" {
			newKey = k
		}
	}
	return newName, newKey, newSlug, newName != name || newKey != key || newSlug != slug
}

// companiesByHolderKey indexes listed companies by holderKey(name), dropping
// any key two companies share, so an exact name match is unambiguous.
func companiesByHolderKey(companies map[string]company) map[string]string {
	out := map[string]string{}
	dup := map[string]bool{}
	for code, c := range companies {
		k := holderKey(c.Name)
		if k == "" {
			continue
		}
		if prev, ok := out[k]; ok && prev != code {
			dup[k] = true
			continue
		}
		out[k] = code
	}
	for k := range dup {
		delete(out, k)
	}
	return out
}

// votesConsistent checks a notice's votes against the shares the company has
// on issue (ASIC's daily short position report): votes / voting power is the
// share count the notice implies. A mis-split cell implies a company a
// hundred times too small or large; a real notice lands within a factor of
// two even across a placement or a buyback.
func votesConsistent(votes *int64, pct *float64, issued float64) (bool, string) {
	if votes == nil || pct == nil || *pct <= 0 || issued <= 0 {
		return true, ""
	}
	implied := float64(*votes) * 100 / *pct
	ratio := implied / issued
	if ratio < 0.5 || ratio > 2 {
		return false, fmt.Sprintf("%d votes at %.4g%% implies %.0f shares; %.0f on issue", *votes, *pct, implied, issued)
	}
	return true, ""
}

// plausibleEventDate keeps a notice's event date only when it falls in the
// year before the notice was released (or the day after, for a timezone).
func plausibleEventDate(event, announced string) string {
	e, err1 := time.Parse("2006-01-02", event)
	a, err2 := time.Parse("2006-01-02", announced)
	if err1 != nil || err2 != nil {
		return ""
	}
	if e.After(a.AddDate(0, 0, 1)) || e.Before(a.AddDate(-1, 0, 0)) {
		return ""
	}
	return event
}

type noticePassResult struct {
	Selected int
	Parsed   int
	Outcomes map[string]int
}

// noticePass carries one run's collaborators.
type noticePass struct {
	store     noticeStore
	pdfs      pdfSource
	extractor textExtractor
	workers   int
	delay     time.Duration
	dryRun    bool
	logf      func(string, ...any)
}

func (p *noticePass) run(ctx context.Context, limit int, since string) (noticePassResult, error) {
	pending, err := p.store.PendingNotices(ctx, limit, since, noticeParserVersion)
	if err != nil {
		return noticePassResult{}, fmt.Errorf("select pending notices: %w", err)
	}
	res := noticePassResult{Selected: len(pending), Outcomes: map[string]int{}}
	if len(pending) == 0 {
		return res, nil
	}
	companies, err := p.store.Companies(ctx)
	if err != nil {
		return res, fmt.Errorf("load companies: %w", err)
	}
	byKey := companiesByHolderKey(companies)

	var mu sync.Mutex
	tally := func(outcome string) {
		mu.Lock()
		defer mu.Unlock()
		res.Outcomes[outcome]++
		if outcome == string(outcomeParsed) {
			res.Parsed++
		}
	}
	record := func(n pendingNotice, code, outcome, detail string) {
		tally(outcome)
		if p.dryRun {
			if outcome != string(outcomeParsed) {
				p.logf("DRY-RUN notice %s (%s): %s %s", n.URL, n.Headline, outcome, detail)
			}
			return
		}
		if code == "" && len(n.ListedCodes) > 0 {
			code = uniqueSorted(n.ListedCodes)[0]
		}
		if err := p.store.RecordAttempt(ctx, noticeAttempt{URL: n.URL, StockCode: code, Outcome: outcome, Detail: detail}, noticeParserVersion); err != nil {
			p.logf("notice %s: recording outcome %s failed: %v", n.URL, outcome, err) // re-selected next run
		}
	}

	handle := func(n pendingNotice) {
		data, err := p.pdfs.PDF(ctx, n.URL)
		if err != nil {
			record(n, "", outcomeFetchError, err.Error())
			return
		}
		text, err := p.extractor.extract(ctx, data)
		if err != nil {
			record(n, "", string(outcomeNoText), err.Error())
			return
		}
		notice, outcome, detail := parseSubstantialNotice(text, n.Headline)
		if outcome != outcomeParsed {
			record(n, "", string(outcome), detail)
			return
		}
		code, why := resolveTarget(n, notice.CompanyName, companies)
		if code == "" {
			record(n, "", outcomeAmbiguousTarget, why)
			return
		}
		holder, ok := resolveHolder(notice, text, byKey)
		if !ok {
			record(n, code, outcomeNoHolder, "section 1 names no holder that can be read")
			return
		}
		eventDate := plausibleEventDate(notice.EventDate, n.AnnouncedOn)
		asAt := eventDate
		if asAt == "" {
			asAt = n.AnnouncedOn
		}
		issued, err := p.store.SharesOnIssue(ctx, code, asAt)
		if err != nil {
			p.logf("notice %s: shares on issue failed: %v", n.URL, err)
			tally("store_error") // no attempt recorded, so it is retried next run
			return
		}
		if ok, why := votesConsistent(notice.PresentVotes, notice.PresentPct, issued); !ok {
			record(n, code, outcomeInconsistentVotes, why)
			return
		}
		row := noticeRow{
			URL: n.URL, StockCode: code, Form: notice.Form, HolderName: holder.Name, HolderKey: holder.Key,
			InstitutionSlug: holder.InstitutionSlug, EventDate: eventDate,
			AnnouncedOn: n.AnnouncedOn, PreviousPct: notice.PreviousPct, PresentPct: notice.PresentPct,
			PreviousVotes: notice.PreviousVotes, PresentVotes: notice.PresentVotes, Ceased: notice.Ceased,
		}
		if p.dryRun {
			p.logf("DRY-RUN notice %s %s %s %s: present %s previous %s ceased=%v (%s)", code, row.Form, row.HolderKey,
				row.EventDate, fmtPct(row.PresentPct), fmtPct(row.PreviousPct), row.Ceased, n.URL)
			tally(string(outcomeParsed))
			return
		}
		if err := p.store.UpsertNotice(ctx, row); err != nil {
			p.logf("notice %s: upsert failed: %v", n.URL, err)
			tally("store_error") // no attempt recorded, so it is retried next run
			return
		}
		record(n, code, string(outcomeParsed), "")
	}

	work := make(chan pendingNotice)
	var wg sync.WaitGroup
	workers := max(p.workers, 1)
	for range workers {
		wg.Go(func() {
			for n := range work {
				handle(n)
				if p.delay <= 0 {
					continue
				}
				t := time.NewTimer(p.delay)
				select {
				case <-t.C:
				case <-ctx.Done():
					t.Stop()
					return
				}
			}
		})
	}
	go func() {
		defer close(work)
		for _, n := range pending {
			select {
			case work <- n:
			case <-ctx.Done():
				return
			}
		}
	}()
	wg.Wait()
	return res, ctx.Err()
}

func fmtPct(p *float64) string {
	if p == nil {
		return "-"
	}
	return fmt.Sprintf("%.2f%%", *p)
}
