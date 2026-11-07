package shorts

// market_moves_validate.go turns a posted market move into the row the store
// writes, or into the list of everything wrong with it.
//
// The poster is a model. Two consequences shape the rules:
//
//   - Every error is reported at once, field by field, in words a model can act
//     on. A poster that learns of one mistake per round trip burns its budget
//     rediscovering the rest.
//   - Withhold rather than guess. A code we do not hold, a direction that
//     contradicts its own figure, a source that is not https: each is refused,
//     never corrected or dropped in silence. A correction would publish what
//     the poster did not say; a silent drop would publish less than it believes.
//
// Text is plain text. The site renders it as text, never as HTML or markdown,
// so nothing here escapes it; it only bounds it and removes control characters.

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"net"
	"net/url"
	"regexp"
	"slices"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
)

// MarketMoveInput is the JSON body of POST /v1/market-moves and the admin MCP
// tool's input. Field names are the proto's (snake_case).
type MarketMoveInput struct {
	MoveKey      string             `json:"move_key"`
	Kind         string             `json:"kind"`
	StockCode    string             `json:"stock_code,omitempty"`
	IndexCode    string             `json:"index_code,omitempty"`
	Sector       string             `json:"sector,omitempty"`
	RelatedCodes []string           `json:"related_codes,omitempty"`
	Direction    string             `json:"direction"`
	ChangePct    *float64           `json:"change_pct,omitempty"`
	Price        *float64           `json:"price,omitempty"`
	VolumeRatio  *float64           `json:"volume_ratio,omitempty"`
	Headline     string             `json:"headline"`
	Summary      string             `json:"summary"`
	Sources      []MarketMoveSource `json:"sources,omitempty"`
	Tags         []string           `json:"tags,omitempty"`
	Significance int                `json:"significance,omitempty"`
	ObservedAt   string             `json:"observed_at"`
	Model        string             `json:"model,omitempty"`
	RunID        string             `json:"run_id,omitempty"`
}

// MarketMoveSource is one cited source in a post.
type MarketMoveSource struct {
	Title     string `json:"title"`
	URL       string `json:"url"`
	Publisher string `json:"publisher,omitempty"`
}

// MarketMoveFieldError is one thing wrong with a post.
type MarketMoveFieldError struct {
	Field   string `json:"field"`
	Message string `json:"message"`
}

// The bounds. The migration's CHECKs hold the same shape (000160); these are
// the writer's, and are what a poster is told.
const (
	marketMoveHeadlineMin   = 8
	marketMoveHeadlineMax   = 140
	marketMoveSummaryMin    = 20
	marketMoveSummaryMax    = 1200
	marketMoveSectorMax     = 80
	marketMoveMaxRelated    = 10
	marketMoveMaxSources    = 6
	marketMoveMaxTags       = 8
	marketMoveSourceTitle   = 200
	marketMoveSourceURL     = 2048
	marketMovePublisherMax  = 80
	marketMoveRetractMax    = 280
	marketMoveFlatThreshold = 0.5 // |change_pct| at or under this may be called flat
	// A move is news: an observation older than this is refused, and one more
	// than marketMoveFutureSkew ahead of the server's clock is refused.
	marketMoveMaxAge     = 72 * time.Hour
	marketMoveFutureSkew = 5 * time.Minute
)

var (
	marketMoveKeyPattern   = regexp.MustCompile(`^[a-z0-9][a-z0-9._:-]{2,127}$`)
	marketMoveCodePattern  = regexp.MustCompile(`^[A-Z0-9]{2,6}$`)
	marketMoveIndexPattern = regexp.MustCompile(`^X[A-Z0-9]{2,5}$`)
	marketMoveTagPattern   = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,31}$`)
	marketMoveModelPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:/ -]{0,79}$`)
	marketMoveRunIDPattern = regexp.MustCompile(`^[A-Za-z0-9._:/-]{1,128}$`)
)

var (
	marketMoveKinds      = []string{"stock", "index", "sector", "market"}
	marketMoveDirections = []string{"up", "down", "flat", "mixed"}
)

// marketMoveDraft is a validated post, before its codes are checked against
// the database. codes lists every stock code it names, primary first.
type marketMoveDraft struct {
	record shortsstore.MarketMoveRecord
	codes  []string
}

// validateMarketMove checks everything that needs no database. now is the
// server's clock; the returned errors are empty exactly when the draft is good.
// With errors, only the draft's record codes and codes are meaningful.
func validateMarketMove(in MarketMoveInput, now time.Time) (marketMoveDraft, []MarketMoveFieldError) {
	var errs []MarketMoveFieldError
	fail := func(field, format string, args ...any) {
		errs = append(errs, MarketMoveFieldError{Field: field, Message: fmt.Sprintf(format, args...)})
	}
	rec := shortsstore.MarketMoveRecord{}

	// --- the key and the subject -------------------------------------------
	rec.MoveKey = strings.TrimSpace(in.MoveKey)
	if !marketMoveKeyPattern.MatchString(rec.MoveKey) {
		fail("move_key", "required: 3 to 128 characters of a-z, 0-9, '.', '_', ':' or '-', starting with a letter or digit (for example 2026-11-07:bhp:iron-ore). Re-post the same key to revise a move.")
	}
	rec.Kind = strings.TrimSpace(in.Kind)
	if !slices.Contains(marketMoveKinds, rec.Kind) {
		fail("kind", "required: one of %s", strings.Join(marketMoveKinds, ", "))
	}

	rec.StockCode = strings.ToUpper(strings.TrimSpace(in.StockCode))
	rec.IndexCode = strings.ToUpper(strings.TrimSpace(in.IndexCode))
	rec.Sector = collapseSpace(in.Sector)

	switch rec.Kind {
	case "stock":
		if rec.StockCode == "" {
			fail("stock_code", "required for a stock move: the ASX code, for example BHP")
		}
	case "index":
		if rec.IndexCode == "" {
			fail("index_code", "required for an index move: the ASX index code, for example XJO")
		}
	case "sector":
		if rec.Sector == "" {
			fail("sector", "required for a sector move, for example Materials")
		}
	}
	if rec.StockCode != "" {
		if rec.Kind != "stock" {
			fail("stock_code", "only a stock move has a stock_code; name the stocks a %s move mentions in related_codes", orKind(rec.Kind))
		} else if !marketMoveCodePattern.MatchString(rec.StockCode) {
			fail("stock_code", "%q is not an ASX code (2 to 6 letters or digits)", in.StockCode)
		}
	}
	if rec.IndexCode != "" {
		if rec.Kind != "index" {
			fail("index_code", "only an index move has an index_code")
		} else if !marketMoveIndexPattern.MatchString(rec.IndexCode) {
			fail("index_code", "%q is not an ASX index code (X followed by 2 to 5 letters or digits, for example XJO)", in.IndexCode)
		}
	}
	if rec.Sector != "" {
		switch {
		case rec.Kind != "sector":
			fail("sector", "only a sector move has a sector")
		case utf8.RuneCountInString(rec.Sector) < 2 || utf8.RuneCountInString(rec.Sector) > marketMoveSectorMax:
			fail("sector", "2 to %d characters", marketMoveSectorMax)
		case hasControl(rec.Sector):
			fail("sector", "must not contain control characters")
		}
	}

	// --- related codes ------------------------------------------------------
	codes := []string{}
	if rec.StockCode != "" && marketMoveCodePattern.MatchString(rec.StockCode) {
		codes = append(codes, rec.StockCode)
	}
	if len(in.RelatedCodes) > marketMoveMaxRelated {
		fail("related_codes", "at most %d codes", marketMoveMaxRelated)
	}
	rec.RelatedCodes = []string{}
	for i, raw := range in.RelatedCodes {
		code := strings.ToUpper(strings.TrimSpace(raw))
		if !marketMoveCodePattern.MatchString(code) {
			fail(fmt.Sprintf("related_codes[%d]", i), "%q is not an ASX code (2 to 6 letters or digits)", raw)
			continue
		}
		if code == rec.StockCode || slices.Contains(rec.RelatedCodes, code) {
			continue // the move's own code, or a repeat: naming it twice says nothing more
		}
		rec.RelatedCodes = append(rec.RelatedCodes, code)
		codes = append(codes, code)
	}

	// --- direction and figures ----------------------------------------------
	rec.Direction = strings.TrimSpace(in.Direction)
	if !slices.Contains(marketMoveDirections, rec.Direction) {
		fail("direction", "required: one of %s", strings.Join(marketMoveDirections, ", "))
	}
	if in.ChangePct == nil {
		if rec.Kind == "stock" || rec.Kind == "index" {
			fail("change_pct", "required for a %s move: the move in percent (-3.2 for a 3.2%% fall)", rec.Kind)
		}
	} else {
		v := *in.ChangePct
		switch {
		case math.IsNaN(v) || math.IsInf(v, 0):
			fail("change_pct", "must be a finite number")
		case v < -100 || v > 1000:
			fail("change_pct", "must be between -100 and 1000 (percent)")
		default:
			v = math.Round(v*1000) / 1000
			rec.ChangePct = &v
			switch rec.Direction {
			case "up":
				if v <= 0 {
					fail("direction", "is up but change_pct is %s; a rise has a positive change_pct", formatPct(v))
				}
			case "down":
				if v >= 0 {
					fail("direction", "is down but change_pct is %s; a fall has a negative change_pct", formatPct(v))
				}
			case "flat":
				if math.Abs(v) > marketMoveFlatThreshold {
					fail("direction", "is flat but change_pct is %s; flat is at most %.1f%% either way", formatPct(v), marketMoveFlatThreshold)
				}
			}
		}
	}
	if in.Price != nil {
		v := *in.Price
		if math.IsNaN(v) || math.IsInf(v, 0) || v <= 0 || v >= 1e10 {
			fail("price", "must be a positive number (the price, or the index level, at observed_at)")
		} else {
			v = math.Round(v*10000) / 10000
			rec.Price = &v
		}
	}
	if in.VolumeRatio != nil {
		v := *in.VolumeRatio
		if math.IsNaN(v) || math.IsInf(v, 0) || v < 0 || v >= 1e6 {
			fail("volume_ratio", "must be zero or more (volume against its usual level: 2.5 is two and a half times)")
		} else {
			v = math.Round(v*100) / 100
			rec.VolumeRatio = &v
		}
	}

	// --- text ---------------------------------------------------------------
	rec.Headline = collapseSpace(in.Headline)
	switch n := utf8.RuneCountInString(rec.Headline); {
	case n < marketMoveHeadlineMin || n > marketMoveHeadlineMax:
		fail("headline", "required: %d to %d characters of plain text (it has %d)", marketMoveHeadlineMin, marketMoveHeadlineMax, n)
	case hasControl(rec.Headline):
		fail("headline", "must not contain control characters")
	}
	rec.Summary = normalizeParagraphs(in.Summary)
	switch n := utf8.RuneCountInString(rec.Summary); {
	case n < marketMoveSummaryMin || n > marketMoveSummaryMax:
		fail("summary", "required: %d to %d characters of plain text saying why it moved (it has %d)", marketMoveSummaryMin, marketMoveSummaryMax, n)
	case hasControl(strings.ReplaceAll(rec.Summary, "\n", "")):
		fail("summary", "must not contain control characters other than line breaks")
	}

	// --- sources and tags ---------------------------------------------------
	if len(in.Sources) > marketMoveMaxSources {
		fail("sources", "at most %d sources", marketMoveMaxSources)
	}
	rec.Sources = []shortsstore.MarketMoveSource{}
	seenURL := map[string]bool{}
	for i, src := range in.Sources {
		field := fmt.Sprintf("sources[%d]", i)
		title := collapseSpace(src.Title)
		publisher := collapseSpace(src.Publisher)
		link := strings.TrimSpace(src.URL)
		ok := true
		if n := utf8.RuneCountInString(title); n < 1 || n > marketMoveSourceTitle || hasControl(title) {
			fail(field+".title", "required: 1 to %d characters of plain text", marketMoveSourceTitle)
			ok = false
		}
		if utf8.RuneCountInString(publisher) > marketMovePublisherMax || hasControl(publisher) {
			fail(field+".publisher", "at most %d characters of plain text", marketMovePublisherMax)
			ok = false
		}
		if reason := sourceURLProblem(link); reason != "" {
			fail(field+".url", "%s", reason)
			ok = false
		}
		if ok && !seenURL[link] {
			seenURL[link] = true
			rec.Sources = append(rec.Sources, shortsstore.MarketMoveSource{Title: title, URL: link, Publisher: publisher})
		}
	}
	if len(in.Tags) > marketMoveMaxTags {
		fail("tags", "at most %d tags", marketMoveMaxTags)
	}
	rec.Tags = []string{}
	for i, raw := range in.Tags {
		tag := strings.ToLower(strings.TrimSpace(raw))
		if !marketMoveTagPattern.MatchString(tag) {
			fail(fmt.Sprintf("tags[%d]", i), "%q is not a tag: 1 to 32 characters of a-z, 0-9 and '-', starting with a letter or digit", raw)
			continue
		}
		if !slices.Contains(rec.Tags, tag) {
			rec.Tags = append(rec.Tags, tag)
		}
	}

	rec.Significance = in.Significance
	if rec.Significance == 0 {
		rec.Significance = 3
	}
	if rec.Significance < 1 || rec.Significance > 5 {
		fail("significance", "1 (minor) to 5 (a market-wide event); leave it out for 3")
	}

	// --- time ---------------------------------------------------------------
	observed, err := time.Parse(time.RFC3339, strings.TrimSpace(in.ObservedAt))
	switch {
	case err != nil:
		fail("observed_at", "required: when you observed the move, RFC 3339 with an offset (for example 2026-11-07T14:05:00+11:00)")
	case observed.After(now.Add(marketMoveFutureSkew)):
		fail("observed_at", "%s is in the future (the server's time is %s)", observed.UTC().Format(time.RFC3339), now.UTC().Format(time.RFC3339))
	case observed.Before(now.Add(-marketMoveMaxAge)):
		fail("observed_at", "%s is more than %d hours ago; a market move is posted while it is news", observed.UTC().Format(time.RFC3339), int(marketMoveMaxAge.Hours()))
	default:
		rec.ObservedAt = observed.UTC().Truncate(time.Second)
		rec.MarketDate = observed.In(dividendZone).Format("2006-01-02")
	}

	// --- provenance ---------------------------------------------------------
	rec.Model = strings.TrimSpace(in.Model)
	if rec.Model != "" && !marketMoveModelPattern.MatchString(rec.Model) {
		fail("model", "at most 80 characters of letters, digits, spaces and . _ : / -")
	}
	rec.RunID = strings.TrimSpace(in.RunID)
	if rec.RunID != "" && !marketMoveRunIDPattern.MatchString(rec.RunID) {
		fail("run_id", "at most 128 characters of letters, digits and . _ : / -")
	}

	if len(errs) > 0 {
		// The codes go back with the errors, so the caller can check them against
		// the database in the same answer rather than on the next round trip.
		return marketMoveDraft{record: rec, codes: codes}, errs
	}
	rec.ContentHash = marketMoveContentHash(rec)
	return marketMoveDraft{record: rec, codes: codes}, nil
}

// checkMarketMoveCodes refuses every code the database does not hold. It is
// the second half of validation, after validateMarketMove has passed.
func checkMarketMoveCodes(draft marketMoveDraft, known map[string]bool) []MarketMoveFieldError {
	var errs []MarketMoveFieldError
	if draft.record.StockCode != "" && !known[draft.record.StockCode] {
		errs = append(errs, MarketMoveFieldError{Field: "stock_code", Message: fmt.Sprintf("%s is not an ASX code we hold", draft.record.StockCode)})
	}
	for i, code := range draft.record.RelatedCodes {
		if !known[code] {
			errs = append(errs, MarketMoveFieldError{Field: fmt.Sprintf("related_codes[%d]", i), Message: fmt.Sprintf("%s is not an ASX code we hold; leave it out rather than guess", code)})
		}
	}
	return errs
}

// validateRetractReason bounds a retraction's reason.
func validateRetractReason(reason string) (string, []MarketMoveFieldError) {
	r := collapseSpace(reason)
	if utf8.RuneCountInString(r) > marketMoveRetractMax || hasControl(r) {
		return "", []MarketMoveFieldError{{Field: "reason", Message: fmt.Sprintf("at most %d characters of plain text", marketMoveRetractMax)}}
	}
	return r, nil
}

// marketMoveContentHash is the hash of everything a reader sees, so a re-post
// of the same content is not a revision. The run id is not part of it: the same
// move posted by the next run is the same move.
func marketMoveContentHash(rec shortsstore.MarketMoveRecord) string {
	content := struct {
		Kind, StockCode, IndexCode, Sector, Direction string
		RelatedCodes, Tags                            []string
		ChangePct, Price, VolumeRatio                 *float64
		Headline, Summary                             string
		Sources                                       []shortsstore.MarketMoveSource
		Significance                                  int
		ObservedAt                                    string
		Model                                         string
	}{
		rec.Kind, rec.StockCode, rec.IndexCode, rec.Sector, rec.Direction,
		rec.RelatedCodes, rec.Tags,
		rec.ChangePct, rec.Price, rec.VolumeRatio,
		rec.Headline, rec.Summary,
		rec.Sources,
		rec.Significance,
		rec.ObservedAt.UTC().Format(time.RFC3339),
		rec.Model,
	}
	b, _ := json.Marshal(content) // a struct of strings, numbers and slices always encodes
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

// sourceURLProblem returns why a source URL is refused, or "".
func sourceURLProblem(raw string) string {
	if raw == "" {
		return "required: the https URL of the source"
	}
	if len(raw) > marketMoveSourceURL {
		return fmt.Sprintf("at most %d characters", marketMoveSourceURL)
	}
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.Host == "" || u.Opaque != "" {
		return "must be an absolute https URL"
	}
	if u.User != nil {
		return "must not carry a user name or password"
	}
	host := strings.ToLower(u.Hostname())
	if net.ParseIP(host) != nil {
		return "must name a host, not an IP address"
	}
	if host == "localhost" || !strings.Contains(host, ".") ||
		strings.HasSuffix(host, ".local") || strings.HasSuffix(host, ".internal") || strings.HasSuffix(host, ".localhost") {
		return "must be a public host"
	}
	return ""
}

// collapseSpace trims and folds every run of whitespace, line breaks included,
// into one space.
func collapseSpace(s string) string {
	return strings.Join(strings.Fields(s), " ")
}

// normalizeParagraphs keeps line breaks (at most one blank line between
// paragraphs) and folds other whitespace within each line.
func normalizeParagraphs(s string) string {
	s = strings.ReplaceAll(s, "\r\n", "\n")
	s = strings.ReplaceAll(s, "\r", "\n")
	lines := strings.Split(s, "\n")
	out := make([]string, 0, len(lines))
	blank := false
	for _, line := range lines {
		line = collapseSpace(line)
		if line == "" {
			blank = len(out) > 0
			continue
		}
		if blank {
			out = append(out, "")
			blank = false
		}
		out = append(out, line)
	}
	return strings.Join(out, "\n")
}

// hasControl reports a control or format character (a zero-width or bidi
// override can make a headline read differently from what is stored).
func hasControl(s string) bool {
	for _, r := range s {
		if unicode.IsControl(r) || unicode.Is(unicode.Cf, r) {
			return true
		}
	}
	return false
}

func formatPct(v float64) string {
	return fmt.Sprintf("%g", v)
}

func orKind(kind string) string {
	if kind == "" {
		return "non-stock"
	}
	return kind
}
