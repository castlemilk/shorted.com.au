package main

import (
	"context"
	"crypto/sha1"
	"encoding/hex"
	"fmt"
	"log"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode"

	"github.com/jackc/pgx/v5/pgxpool"
)

// ClusterNewsOpts configures a clustering run.
type ClusterNewsOpts struct {
	// LookbackHours is how far back to consider unclustered articles.
	// A 24h window comfortably covers same-day coverage by all sources.
	LookbackHours int
	// MinShingleOverlap is the minimum number of shared 3-grams between
	// two headlines to count as the same story (after stock_code match).
	MinShingleOverlap int
	DryRun            bool
}

// clusterCandidate is an unclustered news_articles row.
type clusterCandidate struct {
	id          string
	stockCode   string
	headline    string
	publishedAt time.Time
	shingles    map[string]struct{}
}

// ClusterNews scans recent unclustered articles, groups duplicate-event
// coverage by (stock_code, 3-gram headline shingles, 12h window), and
// writes back a shared cluster_id + a single primary marker per group.
func ClusterNews(ctx context.Context, db *pgxpool.Pool, opts ClusterNewsOpts) error {
	if opts.LookbackHours <= 0 {
		opts.LookbackHours = 48
	}
	if opts.MinShingleOverlap <= 0 {
		opts.MinShingleOverlap = 3
	}

	rows, err := db.Query(ctx, fmt.Sprintf(`
		SELECT id::text, COALESCE(stock_code, ''), headline, published_at
		FROM news_articles
		WHERE cluster_id IS NULL
		  AND published_at > NOW() - INTERVAL '%d hours'
		ORDER BY published_at DESC
	`, opts.LookbackHours))
	if err != nil {
		return fmt.Errorf("query candidates: %w", err)
	}
	defer rows.Close()

	var candidates []*clusterCandidate
	for rows.Next() {
		var c clusterCandidate
		var ts time.Time
		if err := rows.Scan(&c.id, &c.stockCode, &c.headline, &ts); err != nil {
			return fmt.Errorf("scan candidate: %w", err)
		}
		c.publishedAt = ts
		c.shingles = makeShingles(c.headline, 3)
		if len(c.shingles) >= opts.MinShingleOverlap {
			candidates = append(candidates, &c)
		}
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("iterate candidates: %w", err)
	}

	log.Printf("ClusterNews: %d candidates in last %dh, dry_run=%v",
		len(candidates), opts.LookbackHours, opts.DryRun)

	// Bucket by stock_code so the O(n²) shingle comparison stays cheap.
	byStock := map[string][]*clusterCandidate{}
	for _, c := range candidates {
		key := c.stockCode
		if key == "" {
			key = "_MARKET"
		}
		byStock[key] = append(byStock[key], c)
	}

	// Union-find over candidate indices to merge transitively (A~B and
	// B~C should produce a single cluster {A,B,C}).
	parent := make(map[string]string, len(candidates))
	for _, c := range candidates {
		parent[c.id] = c.id
	}
	var find func(string) string
	find = func(x string) string {
		if parent[x] != x {
			parent[x] = find(parent[x])
		}
		return parent[x]
	}
	union := func(a, b string) {
		ra, rb := find(a), find(b)
		if ra != rb {
			parent[ra] = rb
		}
	}

	const maxTimeGap = 12 * time.Hour
	for _, group := range byStock {
		// Within each stock-code bucket, compare each pair within the
		// time window for shingle overlap.
		for i := 0; i < len(group); i++ {
			a := group[i]
			for j := i + 1; j < len(group); j++ {
				b := group[j]
				dt := a.publishedAt.Sub(b.publishedAt)
				if dt < 0 {
					dt = -dt
				}
				if dt > maxTimeGap {
					continue
				}
				if shingleOverlap(a.shingles, b.shingles) >= opts.MinShingleOverlap {
					union(a.id, b.id)
				}
			}
		}
	}

	// Materialise clusters from union-find roots.
	clusterMembers := map[string][]*clusterCandidate{}
	idLookup := map[string]*clusterCandidate{}
	for _, c := range candidates {
		idLookup[c.id] = c
	}
	for id := range parent {
		root := find(id)
		clusterMembers[root] = append(clusterMembers[root], idLookup[id])
	}

	updated := 0
	created := 0
	for root, members := range clusterMembers {
		if len(members) < 2 {
			continue // single-source stories don't need a cluster row
		}
		// Pick primary: earliest publication time, tiebreak by source
		// alphabetical (deterministic).
		sort.Slice(members, func(i, j int) bool {
			if members[i].publishedAt.Equal(members[j].publishedAt) {
				return members[i].id < members[j].id
			}
			return members[i].publishedAt.Before(members[j].publishedAt)
		})
		primary := members[0]
		clusterID := clusterUUIDFromRoot(root)

		if opts.DryRun {
			headlines := []string{}
			for _, m := range members {
				headlines = append(headlines, fmt.Sprintf("  - [%s] %s",
					m.id[:8], truncate(m.headline, 80)))
			}
			log.Printf("  cluster %s (n=%d): primary=%s\n%s",
				clusterID[:8], len(members), primary.id[:8], strings.Join(headlines, "\n"))
			created++
			continue
		}

		// Mark all members.
		ids := make([]string, len(members))
		for i, m := range members {
			ids[i] = m.id
		}
		updateCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		_, err := db.Exec(updateCtx, `
			UPDATE news_articles
			SET cluster_id = $1,
			    cluster_is_primary = (id = $2)
			WHERE id = ANY($3) AND cluster_id IS NULL
		`, clusterID, primary.id, ids)
		cancel()
		if err != nil {
			log.Printf("  failed to write cluster %s: %v", clusterID[:8], err)
			continue
		}
		updated += len(members)
		created++
	}

	log.Printf("ClusterNews done: clusters_created=%d articles_clustered=%d", created, updated)
	return nil
}

// makeShingles returns the set of n-character word n-grams in a headline.
// Lowercases, drops punctuation, drops stopwords. n=3 catches most
// near-duplicate headlines without overfitting to short ones.
var stopwords = map[string]struct{}{
	"a": {}, "an": {}, "the": {}, "of": {}, "to": {}, "in": {}, "on": {},
	"for": {}, "and": {}, "or": {}, "is": {}, "are": {}, "as": {},
	"by": {}, "at": {}, "from": {}, "with": {}, "be": {}, "was": {},
	"has": {}, "have": {}, "had": {}, "asx": {},
}

var nonAlnum = regexp.MustCompile(`[^a-z0-9 ]+`)

func makeShingles(headline string, n int) map[string]struct{} {
	lower := strings.ToLower(headline)
	cleaned := nonAlnum.ReplaceAllString(lower, " ")
	fields := strings.Fields(cleaned)
	out := []string{}
	for _, w := range fields {
		if _, ok := stopwords[w]; ok {
			continue
		}
		// Drop single-char tokens.
		if len([]rune(w)) <= 1 {
			continue
		}
		// Drop pure-digit tokens (years, prices) — they add noise.
		allDigit := true
		for _, r := range w {
			if !unicode.IsDigit(r) {
				allDigit = false
				break
			}
		}
		if allDigit {
			continue
		}
		out = append(out, w)
	}
	if len(out) < n {
		return map[string]struct{}{}
	}
	shingles := make(map[string]struct{}, len(out)-n+1)
	for i := 0; i <= len(out)-n; i++ {
		key := strings.Join(out[i:i+n], " ")
		shingles[key] = struct{}{}
	}
	return shingles
}

// shingleOverlap returns the size of the intersection of two shingle sets.
func shingleOverlap(a, b map[string]struct{}) int {
	if len(a) > len(b) {
		a, b = b, a
	}
	count := 0
	for k := range a {
		if _, ok := b[k]; ok {
			count++
		}
	}
	return count
}

// clusterUUIDFromRoot derives a stable cluster UUID from the union-find
// root id (which is one of the article UUIDs in the group). Using the
// root directly keeps cluster identity stable across re-runs as long as
// the earliest article in the cluster doesn't change.
func clusterUUIDFromRoot(root string) string {
	// Hash to produce a deterministic UUIDv5-style string. Postgres will
	// validate it as a UUID when we INSERT.
	h := sha1.Sum([]byte("news-cluster:" + root))
	bytes := h[:16]
	// Set UUID version (5) + variant (RFC 4122) bits.
	bytes[6] = (bytes[6] & 0x0f) | 0x50
	bytes[8] = (bytes[8] & 0x3f) | 0x80
	hexStr := hex.EncodeToString(bytes)
	return fmt.Sprintf("%s-%s-%s-%s-%s",
		hexStr[0:8], hexStr[8:12], hexStr[12:16], hexStr[16:20], hexStr[20:32])
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}
