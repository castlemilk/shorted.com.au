package shorts

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
)

const editorialTakeColumns = `id::text, slug, headline, stock_code, body_md, sentiment,
	source_article_id::text, source_url, source_name, og_image_url, word_count, model,
	published_at, created_at`

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
	); err != nil {
		return nil, err
	}
	return t, nil
}
