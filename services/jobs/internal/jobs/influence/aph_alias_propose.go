package influence

// Proposes declared-name -> ASX-code aliases for a HUMAN to confirm.
//
// THE CONSTRAINT THIS IS BUILT AROUND: register_item_securities_public_gate
// permits resolution_status='resolved' only for match_method IN
// ('curated_alias','ticker_in_text','name_exact'). A model's answer is
// 'analyst_fuzzy' by definition and can never be published. So this mode does
// NOT resolve anything. It writes register_alias_proposals, which no resolver
// and no read path reads, and a person promotes the good ones.
//
// Why a model helps at all: §8.13 established that the bottleneck is ENTITY
// LINKING, not perception — the vision tier already reads "AGL Ltd" perfectly;
// what is hard is knowing it means AGL Energy Limited. That is a judgement a
// person can make in one keystroke but cannot make 1,800 times. The model's job
// is to turn "here are 1,800 unmatched names" into "here are 1,800 one-keystroke
// decisions, ordered by how many rows each fixes".
//
// The shortlist is built DETERMINISTICALLY here, not by the model, and is stored
// with the answer. The model only ever CHOOSES FROM a list we computed, or says
// NONE — it is never asked to recall an ASX code from memory, which is where a
// hallucinated ticker would come from.

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"sort"
	"strconv"
	"strings"

	"github.com/google/generative-ai-go/genai"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"google.golang.org/api/option"
)

const aliasProposalModel = "gemini-3.1-flash-lite"

// shortlistSize caps how many listings the model chooses from. Small enough that
// the whole list fits in the prompt and a reviewer can re-read it, large enough
// that the right answer is usually present.
const shortlistSize = 12

// aliasCandidate is one unmatched declared name and how much it is worth.
type aliasCandidate struct {
	Norm        string
	Sample      string
	Occurrences int
}

// listing is one ASX company as the model will see it.
type listing struct {
	Code string `json:"code"`
	Name string `json:"name"`
	norm string
}

// loadAliasCandidates returns the unmatched names worth a decision, most
// frequent first. Only entity_kind='listed' — a trust or a gift line is not a
// missing alias, and offering it for review wastes the reviewer's attention,
// which is the scarce resource here.
func loadAliasCandidates(ctx context.Context, pool *pgxpool.Pool, limit int) ([]aliasCandidate, error) {
	rows, err := pool.Query(ctx, `
		SELECT s.candidate_norm,
		       (array_agg(s.candidate_raw ORDER BY length(s.candidate_raw)))[1] AS sample,
		       count(*) AS occurrences
		FROM register_item_securities s
		JOIN register_declared_items i ON i.id = s.item_id
		WHERE i.item_no IN (1, 4)
		  -- NOT restricted to entity_kind='listed'.
		  --
		  -- It was, and that quietly disabled the remedy: §8.19's cell-context rule
		  -- reclassifies unmatched item-1 candidates to 'not_an_entity', so 1,301
		  -- distinct names became invisible to the proposer — the one lever §9 names
		  -- as the legitimate way to raise resolution. A name the classifier could
		  -- not explain is EXACTLY what a human should be shown.
		  --
		  -- 'not_an_entity' is still excluded for candidates the SPLITTER rejected
		  -- (prose, gift log lines, holder labels): those carry a Reject reason and
		  -- are not names at all. The distinction is match_method IS NULL AND a
		  -- non-empty norm, which the length filter below already enforces.
		  AND s.entity_kind IN ('listed', 'not_an_entity')
		  AND s.resolution_status IN ('unmatched', 'ambiguous')
		  AND btrim(s.candidate_norm) <> ''
		  AND length(s.candidate_norm) >= 3
		  -- Skip anything a human has already ruled on, in either table.
		  AND NOT EXISTS (SELECT 1 FROM register_security_aliases a WHERE a.alias_norm = s.candidate_norm)
		  AND NOT EXISTS (SELECT 1 FROM register_alias_proposals p WHERE p.candidate_norm = s.candidate_norm)
		GROUP BY 1
		ORDER BY occurrences DESC, 1
		LIMIT $1`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []aliasCandidate
	for rows.Next() {
		var c aliasCandidate
		if err := rows.Scan(&c.Norm, &c.Sample, &c.Occurrences); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

func loadListings(ctx context.Context, pool *pgxpool.Pool) ([]listing, error) {
	rows, err := pool.Query(ctx, `
		SELECT stock_code, company_name FROM "company-metadata"
		WHERE company_name IS NOT NULL AND btrim(company_name) <> ''
		  AND stock_code IS NOT NULL AND btrim(stock_code) <> ''`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []listing
	for rows.Next() {
		var l listing
		if err := rows.Scan(&l.Code, &l.Name); err != nil {
			return nil, err
		}
		l.norm = widenEntityName(l.Name)
		out = append(out, l)
	}
	return out, rows.Err()
}

// tokens splits a normalised name into the words worth indexing.
func tokens(s string) []string {
	var out []string
	for _, w := range strings.Fields(s) {
		if len(w) >= 3 {
			out = append(out, w)
		}
	}
	return out
}

// shortlistFor picks the listings a candidate could plausibly be, by shared
// tokens and shared prefixes. DETERMINISTIC and cheap: the model never searches,
// it only chooses from this.
func shortlistFor(cand string, listings []listing, index map[string][]int) []listing {
	scores := map[int]float64{}
	candTokens := tokens(cand)

	for _, t := range candTokens {
		for _, i := range index[t] {
			// A rarer shared token is stronger evidence than a common one.
			scores[i] += 1.0 / float64(1+len(index[t]))
		}
	}
	// A shared leading prefix catches "WOODSIDE" against "WOODSIDE ENERGY" even
	// when no whole token matches (abbreviations, run-together names).
	if len(cand) >= 4 {
		head := cand
		if len(head) > 6 {
			head = head[:6]
		}
		for i, l := range listings {
			if strings.HasPrefix(l.norm, head) || strings.HasPrefix(cand, l.norm) {
				scores[i] += 0.5
			}
		}
	}

	type scored struct {
		i int
		s float64
	}
	var ranked []scored
	for i, s := range scores {
		ranked = append(ranked, scored{i, s})
	}
	sort.Slice(ranked, func(a, b int) bool {
		if ranked[a].s != ranked[b].s {
			return ranked[a].s > ranked[b].s
		}
		return listings[ranked[a].i].Code < listings[ranked[b].i].Code
	})

	var out []listing
	for _, r := range ranked {
		if len(out) >= shortlistSize {
			break
		}
		out = append(out, listings[r.i])
	}
	return out
}

// aliasAnswer is what the model must return.
type aliasAnswer struct {
	Code       string  `json:"code"`
	Confidence float64 `json:"confidence"`
	Why        string  `json:"why"`
}

const aliasPromptHeader = `You are helping an Australian financial-data team link text a federal MP wrote on
their Register of Interests to a company listed on the ASX.

You will be given ONE declared entry and a SHORTLIST of ASX listings. Choose the
listing that is THE SAME COMPANY as the declared entry, or answer NONE.

Rules, in order of importance:
1. Answer with a code from the shortlist ONLY. Never invent a code, and never
   answer with a code that is not in the list, even if you believe it exists.
2. If you are not confident the declared entry names the SAME company, answer
   NONE. A wrong link is published next to a named politician, so a miss is far
   cheaper than a wrong answer.
3. The declared entry is often a colloquial or abbreviated Australian name:
   "Woodside" is Woodside Energy, "the Commonwealth Bank"/"CBA" is Commonwealth
   Bank of Australia, "Telstra" is Telstra Group, "BHP" is BHP Group.
4. The ASX company_name values are abbreviated and sometimes mangled
   ("Vngd Aus Shares Etf Units" is Vanguard Australian Shares ETF). Judge by the
   company, not by string similarity.
5. Answer NONE if the entry is a PRIVATE company (Pty Ltd), a family trust, a
   self-managed super fund, a foreign listing, a bank ACCOUNT rather than a
   shareholding, a gift, or a property. Those are real declarations but they are
   not ASX listings.
6. Answer NONE if the entry names a company that was once listed but is not in
   the shortlist. Do NOT map it to a similarly-named current listing — ASX codes
   get recycled, and CCL is now Cuscal, not Coca-Cola Amatil.

Return JSON only: {"code": "<CODE or NONE>", "confidence": <0..1>, "why": "<one short sentence>"}`

func aliasPrompt(c aliasCandidate, shortlist []listing) string {
	var b strings.Builder
	b.WriteString(aliasPromptHeader)
	b.WriteString("\n\nDECLARED ENTRY (verbatim from the register): ")
	b.WriteString(strconv.Quote(c.Sample))
	b.WriteString("\nNORMALISED: ")
	b.WriteString(c.Norm)
	b.WriteString("\n\nSHORTLIST:\n")
	for _, l := range shortlist {
		fmt.Fprintf(&b, "  %s = %s\n", l.Code, l.Name)
	}
	return b.String()
}

// runRegisterAliasPropose asks the model for one decision per unmatched name and
// stores it for review. It NEVER writes register_security_aliases.
func runRegisterAliasPropose(ctx context.Context, pool *pgxpool.Pool, limit int, dryRun bool) (int, error) {
	apiKey := strings.TrimSpace(os.Getenv("GEMINI_API_KEY"))
	if apiKey == "" {
		return 0, fmt.Errorf("GEMINI_API_KEY is required for -mode register-propose-aliases")
	}

	candidates, err := loadAliasCandidates(ctx, pool, limit)
	if err != nil {
		return 0, fmt.Errorf("load candidates: %w", err)
	}
	if len(candidates) == 0 {
		return 0, nil
	}
	listings, err := loadListings(ctx, pool)
	if err != nil {
		return 0, fmt.Errorf("load listings: %w", err)
	}

	index := map[string][]int{}
	for i, l := range listings {
		for _, t := range tokens(l.norm) {
			index[t] = append(index[t], i)
		}
	}

	client, err := genai.NewClient(ctx, option.WithAPIKey(apiKey))
	if err != nil {
		return 0, fmt.Errorf("gemini client: %w", err)
	}
	defer func() { _ = client.Close() }()

	model := client.GenerativeModel(aliasProposalModel)
	model.ResponseMIMEType = "application/json"

	valid := map[string]listing{}
	for _, l := range listings {
		valid[strings.ToUpper(l.Code)] = l
	}

	written := 0
	for _, c := range candidates {
		shortlist := shortlistFor(c.Norm, listings, index)
		if len(shortlist) == 0 {
			continue
		}

		answer, raw, err := askForAlias(ctx, model, c, shortlist)
		if err != nil {
			log.Printf("[register-propose-aliases] %q: %v", c.Norm, err)
			continue
		}

		// THE MODEL'S ANSWER IS VALIDATED, NOT TRUSTED. It must name a code that
		// exists AND that was actually on the shortlist we gave it; anything
		// else is a hallucination and is recorded as NONE.
		var code, name string
		if up := strings.ToUpper(strings.TrimSpace(answer.Code)); up != "" && up != "NONE" {
			onShortlist := false
			for _, l := range shortlist {
				if strings.EqualFold(l.Code, up) {
					onShortlist = true
					break
				}
			}
			if l, ok := valid[up]; ok && onShortlist {
				code, name = l.Code, l.Name
			} else {
				log.Printf("[register-propose-aliases] %q: model returned %q which is not on its own shortlist — recorded as NONE",
					c.Norm, answer.Code)
			}
		}

		if dryRun {
			log.Printf("[register-propose-aliases] DRY RUN %-28s x%-3d -> %-6s %s",
				c.Norm, c.Occurrences, firstNonEmptyAlias(code, "NONE"), answer.Why)
			written++
			continue
		}

		shortlistJSON, _ := json.Marshal(shortlist)
		var codeArg any
		if code != "" {
			codeArg = code
		}
		if _, err := pool.Exec(ctx, `
			INSERT INTO register_alias_proposals
				(candidate_norm, candidate_sample, occurrences, proposed_stock_code,
				 proposed_company_name, shortlist, model, confidence, rationale)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
			ON CONFLICT (candidate_norm) DO NOTHING`,
			// string(), not []byte: pgx sends a byte slice as bytea, which
			// Postgres cannot parse into a jsonb column.
			c.Norm, c.Sample, c.Occurrences, codeArg, name, string(shortlistJSON),
			aliasProposalModel, answer.Confidence, strings.TrimSpace(answer.Why)); err != nil {
			return written, fmt.Errorf("insert proposal %q: %w (raw=%s)", c.Norm, err, raw)
		}
		written++
	}
	return written, nil
}

func askForAlias(ctx context.Context, model *genai.GenerativeModel, c aliasCandidate, shortlist []listing) (aliasAnswer, string, error) {
	var out aliasAnswer
	resp, err := model.GenerateContent(ctx, genai.Text(aliasPrompt(c, shortlist)))
	if err != nil {
		return out, "", err
	}
	raw := collectText(resp)
	if strings.TrimSpace(raw) == "" {
		return out, raw, fmt.Errorf("empty response")
	}
	if err := json.Unmarshal([]byte(raw), &out); err != nil {
		return out, raw, fmt.Errorf("decode %q: %w", truncate(raw, 120), err)
	}
	return out, raw, nil
}

func collectText(resp *genai.GenerateContentResponse) string {
	var b strings.Builder
	for _, cand := range resp.Candidates {
		if cand.Content == nil {
			continue
		}
		for _, part := range cand.Content.Parts {
			if t, ok := part.(genai.Text); ok {
				b.WriteString(string(t))
			}
		}
	}
	return b.String()
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}

func firstNonEmptyAlias(v, fallback string) string {
	if strings.TrimSpace(v) != "" {
		return v
	}
	return fallback
}

// promoteAliasProposals copies CONFIRMED proposals into register_security_aliases.
//
// This is the batch path from a model's opinion to a published link, and it runs
// only over rows a human has already marked 'confirmed'. It is idempotent.
//
// THE COLUMN IS `note`, NOT `notes`. This statement shipped naming a column that
// does not exist, and could not fail in practice because nothing had ever been
// confirmed — there was no UI to confirm with, so the one path out of the
// backlog was broken from the day it was written and green the whole time.
// register_review_console.test.mjs now asserts every column named here against
// the migration's own CREATE TABLE, which is the check that generalises.
//
// alias_kind stays 'equity' here on purpose: the resolver reads only
// `resolution` (aph_resolve.go:resolveSecurityStatus), alias_kind is descriptive,
// and a batch promotion has no evidence about whether a code is an equity, an
// ETF or a LIC. The console asks a human, and writes the answer itself.
func promoteAliasProposals(ctx context.Context, pool *pgxpool.Pool) (int64, error) {
	tag, err := pool.Exec(ctx, `
		INSERT INTO register_security_aliases (alias_norm, stock_code, alias_kind, resolution, display_name, note, curated_by)
		SELECT p.candidate_norm, p.proposed_stock_code, 'equity', 'resolved', p.proposed_company_name,
		       'promoted from register_alias_proposals', p.reviewed_by
		FROM register_alias_proposals p
		WHERE p.status = 'confirmed' AND p.proposed_stock_code IS NOT NULL
		ON CONFLICT (alias_norm) DO NOTHING`)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}

var _ = pgx.ErrNoRows
