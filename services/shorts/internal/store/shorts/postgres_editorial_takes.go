package shorts

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

const editorialTakeColumns = `id::text, slug, headline, stock_code, body_md, sentiment,
	source_article_id::text, source_url, source_name, og_image_url, word_count, model,
	published_at, created_at, hero_image_url, inline_images, tweet_published_at`

// GetEditorialTake fetches a published Take by slug. Returns nil, nil if not found.
func (s *postgresStore) GetEditorialTake(slug string) (*EditorialTake, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	row := s.db.QueryRow(ctx,
		`SELECT `+editorialTakeColumns+`
		 FROM editorial_takes
		 WHERE slug = $1 AND published_at IS NOT NULL`, slug)

	t, err := scanEditorialTake(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("get editorial take: %w", err)
	}
	return t, nil
}

// ListEditorialTakes returns recent published Takes, newest first.
func (s *postgresStore) ListEditorialTakes(limit, offset int32, stockCode string) ([]*EditorialTake, int, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	if limit <= 0 {
		limit = 20
	}

	query := `SELECT ` + editorialTakeColumns + `
		 FROM editorial_takes
		 WHERE published_at IS NOT NULL`
	args := []interface{}{}
	idx := 1
	if stockCode != "" {
		query += fmt.Sprintf(" AND stock_code = $%d", idx)
		args = append(args, stockCode)
		idx++
	}
	query += fmt.Sprintf(" ORDER BY published_at DESC LIMIT $%d OFFSET $%d", idx, idx+1)
	args = append(args, limit, offset)

	rows, err := s.db.Query(ctx, query, args...)
	if err != nil {
		return nil, 0, fmt.Errorf("list editorial takes: %w", err)
	}
	defer rows.Close()

	var takes []*EditorialTake
	for rows.Next() {
		t, err := scanEditorialTake(rows)
		if err != nil {
			return nil, 0, fmt.Errorf("scan editorial take: %w", err)
		}
		takes = append(takes, t)
	}
	if err := rows.Err(); err != nil {
		return nil, 0, err
	}

	// Count is approximate (= len, callers paginate via offset). If a true
	// total is needed, add a separate COUNT(*) query; not worth the round-trip yet.
	return takes, len(takes), nil
}

type scannable interface {
	Scan(dest ...interface{}) error
}

func scanEditorialTake(r scannable) (*EditorialTake, error) {
	t := &EditorialTake{}
	if err := r.Scan(
		&t.ID, &t.Slug, &t.Headline, &t.StockCode, &t.BodyMD, &t.Sentiment,
		&t.SourceArticleID, &t.SourceURL, &t.SourceName, &t.OGImageURL,
		&t.WordCount, &t.Model, &t.PublishedAt, &t.CreatedAt,
		&t.HeroImageURL, &t.InlineImages, &t.TweetPublishedAt,
	); err != nil {
		return nil, err
	}
	return t, nil
}

// ListEditorialTakesAdmin includes drafts (no published_at filter).
// statusFilter: "draft" | "published" | "tweeted" | "" (all).
func (s *postgresStore) ListEditorialTakesAdmin(limit, offset int32, statusFilter string) ([]*EditorialTake, int, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	if limit <= 0 {
		limit = 50
	}

	whereClauses := []string{}
	switch statusFilter {
	case "draft":
		whereClauses = append(whereClauses, "published_at IS NULL")
	case "published":
		whereClauses = append(whereClauses, "published_at IS NOT NULL AND tweet_published_at IS NULL")
	case "tweeted":
		whereClauses = append(whereClauses, "tweet_published_at IS NOT NULL")
	}
	where := ""
	if len(whereClauses) > 0 {
		where = "WHERE " + whereClauses[0]
	}

	query := fmt.Sprintf(`SELECT %s FROM editorial_takes %s
		ORDER BY COALESCE(published_at, created_at) DESC
		LIMIT $1 OFFSET $2`, editorialTakeColumns, where)

	rows, err := s.db.Query(ctx, query, limit, offset)
	if err != nil {
		return nil, 0, fmt.Errorf("list takes admin: %w", err)
	}
	defer rows.Close()

	var takes []*EditorialTake
	for rows.Next() {
		t, err := scanEditorialTake(rows)
		if err != nil {
			return nil, 0, fmt.Errorf("scan: %w", err)
		}
		takes = append(takes, t)
	}
	if err := rows.Err(); err != nil {
		return nil, 0, err
	}
	return takes, len(takes), nil
}

// PublishEditorialTake sets published_at = NOW() if it was NULL.
func (s *postgresStore) PublishEditorialTake(slug string) (*EditorialTake, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	row := s.db.QueryRow(ctx, fmt.Sprintf(`
		UPDATE editorial_takes SET published_at = NOW(), updated_at = NOW()
		WHERE slug = $1 AND published_at IS NULL
		RETURNING %s`, editorialTakeColumns), slug)
	t, err := scanEditorialTake(row)
	if errors.Is(err, pgx.ErrNoRows) {
		// Either no such slug, or already published. Re-fetch to disambiguate.
		got, gerr := s.GetEditorialTake(slug)
		if gerr != nil {
			return nil, fmt.Errorf("publish: %w", gerr)
		}
		if got != nil {
			return got, nil // already published
		}
		return nil, fmt.Errorf("publish: take not found: %s", slug)
	}
	if err != nil {
		return nil, fmt.Errorf("publish: %w", err)
	}
	return t, nil
}

// UpdateEditorialTake applies a partial update.
func (s *postgresStore) UpdateEditorialTake(slug string, f EditorialTakeUpdate) (*EditorialTake, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	sets := []string{"updated_at = NOW()"}
	args := []interface{}{}
	idx := 1
	if f.BodyMD != nil {
		sets = append(sets, fmt.Sprintf("body_md = $%d, word_count = $%d", idx, idx+1))
		args = append(args, *f.BodyMD, len(strings.Fields(*f.BodyMD)))
		idx += 2
	}
	if f.Headline != nil {
		sets = append(sets, fmt.Sprintf("headline = $%d", idx))
		args = append(args, *f.Headline)
		idx++
	}
	if f.HeroImageURL != nil {
		sets = append(sets, fmt.Sprintf("hero_image_url = $%d", idx))
		args = append(args, *f.HeroImageURL)
		idx++
	}
	if f.Sentiment != nil {
		sets = append(sets, fmt.Sprintf("sentiment = $%d", idx))
		args = append(args, *f.Sentiment)
		idx++
	}
	args = append(args, slug)

	query := fmt.Sprintf(`UPDATE editorial_takes SET %s WHERE slug = $%d RETURNING %s`,
		strings.Join(sets, ", "), idx, editorialTakeColumns)
	row := s.db.QueryRow(ctx, query, args...)
	t, err := scanEditorialTake(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, fmt.Errorf("update: take not found: %s", slug)
	}
	if err != nil {
		return nil, fmt.Errorf("update: %w", err)
	}
	return t, nil
}

// DeleteEditorialTake hard-deletes by slug.
func (s *postgresStore) DeleteEditorialTake(slug string) (bool, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	tag, err := s.db.Exec(ctx, "DELETE FROM editorial_takes WHERE slug = $1", slug)
	if err != nil {
		return false, fmt.Errorf("delete: %w", err)
	}
	return tag.RowsAffected() > 0, nil
}

// MarkTakeTweetPublished sets tweet_published_at = NOW() if NULL.
func (s *postgresStore) MarkTakeTweetPublished(slug string) (*EditorialTake, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	row := s.db.QueryRow(ctx, fmt.Sprintf(`
		UPDATE editorial_takes SET tweet_published_at = NOW(), updated_at = NOW()
		WHERE slug = $1 AND tweet_published_at IS NULL
		RETURNING %s`, editorialTakeColumns), slug)
	t, err := scanEditorialTake(row)
	if errors.Is(err, pgx.ErrNoRows) {
		got, gerr := s.GetEditorialTake(slug)
		if gerr != nil || got == nil {
			return nil, fmt.Errorf("mark tweet published: take not found: %s", slug)
		}
		return got, nil
	}
	if err != nil {
		return nil, fmt.Errorf("mark tweet published: %w", err)
	}
	return t, nil
}

// ListTweetPublishQueue returns published-but-not-tweeted takes.
func (s *postgresStore) ListTweetPublishQueue(limit int32) ([]*EditorialTake, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if limit <= 0 {
		limit = 10
	}
	rows, err := s.db.Query(ctx, fmt.Sprintf(`SELECT %s FROM editorial_takes
		WHERE published_at IS NOT NULL AND tweet_published_at IS NULL
		ORDER BY published_at ASC LIMIT $1`, editorialTakeColumns), limit)
	if err != nil {
		return nil, fmt.Errorf("list publish queue: %w", err)
	}
	defer rows.Close()
	var takes []*EditorialTake
	for rows.Next() {
		t, err := scanEditorialTake(rows)
		if err != nil {
			return nil, err
		}
		takes = append(takes, t)
	}
	return takes, rows.Err()
}
