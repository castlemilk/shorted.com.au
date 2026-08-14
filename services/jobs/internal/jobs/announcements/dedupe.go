package announcements

import (
	"fmt"
	"strings"
)

// This file holds the pure (DB-free) half of the write path: computing which
// crawled announcements are genuinely new, and turning the survivors into a
// single multi-row parameterized INSERT.
//
// Background: the crawler re-fetches the full announcement history for every
// stock on every daily run (2 years x ~4.5k stocks). It used to issue one
// `INSERT ... ON CONFLICT DO NOTHING` per announcement per table, i.e. ~620k
// statements into asx_announcements and another ~620k into news_articles per
// run, of which only ~330 actually inserted a row. Everything else was a no-op
// round-trip through the Supabase transaction pooler.
//
// Fix: one SELECT of the existing keys per stock code, filter client-side, then
// batch the remainder into chunked multi-row INSERTs. ON CONFLICT DO NOTHING is
// retained so correctness never depends on the pre-filter being perfect (races
// with other writers, or rows added between the SELECT and the INSERT).

// maxInsertRowsPerStatement bounds how many rows go into one multi-row INSERT.
// Well under Postgres' 65535 bind-parameter ceiling at 7 params/row, and small
// enough that a single failed statement doesn't lose a whole stock's backlog.
const maxInsertRowsPerStatement = 200

// storeCounts is the per-call tally of the pre-filter/batch write path, so the
// job can report the no-op ratio (scanned vs skipped vs inserted) per run.
type storeCounts struct {
	scanned  int // announcements handed to the store call
	skipped  int // already present in the DB (or duplicated within the batch)
	inserted int // rows actually written (server-reported RowsAffected)
}

// announcementKey builds the dedup key matching the asx_announcements unique
// constraint: UNIQUE(stock_code, announcement_date, headline). stock_code is
// implied because keys are only ever compared within a single stock code.
func announcementKey(date, headline string) string {
	return date + "\x00" + headline
}

// filterNewAnnouncements returns the announcements whose (date, headline) key is
// not already present in the DB, preserving input order and dropping duplicates
// within the batch itself (the same announcement can appear under two crawled
// years).
func filterNewAnnouncements(announcements []ASXAnnouncement, existing map[string]struct{}) []ASXAnnouncement {
	if len(announcements) == 0 {
		return nil
	}
	seen := make(map[string]struct{}, len(announcements))
	fresh := make([]ASXAnnouncement, 0, len(announcements))
	for _, ann := range announcements {
		key := announcementKey(ann.Date, ann.Headline)
		if _, ok := existing[key]; ok {
			continue
		}
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		fresh = append(fresh, ann)
	}
	return fresh
}

// filterNewNewsArticles returns the announcements whose PDF URL (the
// news_articles conflict key: UNIQUE(url)) is not already stored, dropping
// in-batch duplicates too. Announcements without a URL are skipped entirely —
// url is NOT NULL and an empty string would collide across stocks.
func filterNewNewsArticles(announcements []ASXAnnouncement, existingURLs map[string]struct{}) []ASXAnnouncement {
	if len(announcements) == 0 {
		return nil
	}
	seen := make(map[string]struct{}, len(announcements))
	fresh := make([]ASXAnnouncement, 0, len(announcements))
	for _, ann := range announcements {
		if ann.PDFURL == "" {
			continue
		}
		if _, ok := existingURLs[ann.PDFURL]; ok {
			continue
		}
		if _, ok := seen[ann.PDFURL]; ok {
			continue
		}
		seen[ann.PDFURL] = struct{}{}
		fresh = append(fresh, ann)
	}
	return fresh
}

// chunkAnnouncements splits a slice into batches of at most size elements.
func chunkAnnouncements(announcements []ASXAnnouncement, size int) [][]ASXAnnouncement {
	if size < 1 {
		size = 1
	}
	var chunks [][]ASXAnnouncement
	for start := 0; start < len(announcements); start += size {
		end := start + size
		if end > len(announcements) {
			end = len(announcements)
		}
		chunks = append(chunks, announcements[start:end])
	}
	return chunks
}

// buildAnnouncementInsert builds a single multi-row, fully parameterized INSERT
// for asx_announcements. Returns ("", nil) for an empty batch.
func buildAnnouncementInsert(code string, batch []ASXAnnouncement) (string, []any) {
	if len(batch) == 0 {
		return "", nil
	}
	const colsPerRow = 6
	values := make([]string, 0, len(batch))
	args := make([]any, 0, len(batch)*colsPerRow)
	for i, ann := range batch {
		base := i*colsPerRow + 1
		values = append(values, fmt.Sprintf("($%d, $%d::date, $%d, $%d, $%d, $%d, 'asx_announcements')",
			base, base+1, base+2, base+3, base+4, base+5))
		args = append(args,
			code,
			ann.Date,
			ann.Headline,
			ann.IsPriceSens,
			classifyAnnouncementType(ann.Headline),
			ann.PDFURL,
		)
	}
	query := `INSERT INTO asx_announcements (stock_code, announcement_date, headline, is_price_sensitive, announcement_type, pdf_url, source)
		 VALUES ` + strings.Join(values, ", ") + `
		 ON CONFLICT (stock_code, announcement_date, headline) DO NOTHING`
	return query, args
}

// buildNewsArticleInsert builds a single multi-row, fully parameterized INSERT
// for news_articles. Returns ("", nil) for an empty batch.
func buildNewsArticleInsert(code string, batch []ASXAnnouncement) (string, []any) {
	if len(batch) == 0 {
		return "", nil
	}
	const colsPerRow = 8
	values := make([]string, 0, len(batch))
	args := make([]any, 0, len(batch)*colsPerRow)
	for i, ann := range batch {
		base := i*colsPerRow + 1
		values = append(values, fmt.Sprintf("($%d, 'asx', $%d, $%d, $%d::timestamptz, $%d, $%d, $%d, $%d)",
			base, base+1, base+2, base+3, base+4, base+5, base+6, base+7))
		relevanceScore := 0.5
		if ann.IsPriceSens {
			relevanceScore = 0.9
		}
		args = append(args,
			code,
			ann.Headline,
			ann.PDFURL,
			ann.Date+"T00:00:00+10:00", // AEST
			classifySentiment(ann.Headline),
			relevanceScore,
			ann.IsPriceSens,
			classifyAnnouncementType(ann.Headline)+" announcement",
		)
	}
	query := `INSERT INTO news_articles (stock_code, source, headline, url, published_at, sentiment, relevance_score, is_price_sensitive, summary)
		 VALUES ` + strings.Join(values, ", ") + `
		 ON CONFLICT (url) DO NOTHING`
	return query, args
}
