package shorts

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
)

func (s *postgresStore) CreateBroadcastDraft(b Broadcast) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	var srcRef interface{}
	if b.SourceRef != "" {
		srcRef = b.SourceRef
	}
	var id string
	err := s.db.QueryRow(ctx, `
		INSERT INTO broadcasts (type, subject, html_body, text_body, source_ref)
		VALUES ($1,$2,$3,$4,$5)
		ON CONFLICT (type, source_ref) WHERE source_ref IS NOT NULL DO NOTHING
		RETURNING id`,
		b.Type, b.Subject, b.HTMLBody, b.TextBody, srcRef).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		// ON CONFLICT DO NOTHING → no row returned; idempotent no-op (draft already exists).
		return "", nil
	}
	if err != nil {
		return "", err
	}
	return id, nil
}

func (s *postgresStore) ListBroadcasts(limit int) ([]Broadcast, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	rows, err := s.db.Query(ctx, `
		SELECT id, type, subject, html_body, text_body, COALESCE(source_ref,''),
		       status, recipient_count, COALESCE(error,''), created_at, sent_at
		FROM broadcasts ORDER BY created_at DESC LIMIT $1`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Broadcast
	for rows.Next() {
		var b Broadcast
		if err := rows.Scan(&b.ID, &b.Type, &b.Subject, &b.HTMLBody, &b.TextBody,
			&b.SourceRef, &b.Status, &b.RecipientCount, &b.Error, &b.CreatedAt, &b.SentAt); err != nil {
			return nil, err
		}
		out = append(out, b)
	}
	return out, rows.Err()
}

func (s *postgresStore) GetBroadcast(id string) (*Broadcast, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	var b Broadcast
	err := s.db.QueryRow(ctx, `
		SELECT id, type, subject, html_body, text_body, COALESCE(source_ref,''),
		       status, recipient_count, COALESCE(error,''), created_at, sent_at
		FROM broadcasts WHERE id = $1`, id).
		Scan(&b.ID, &b.Type, &b.Subject, &b.HTMLBody, &b.TextBody, &b.SourceRef,
			&b.Status, &b.RecipientCount, &b.Error, &b.CreatedAt, &b.SentAt)
	if err != nil {
		return nil, err
	}
	return &b, nil
}

func (s *postgresStore) SetBroadcastStatus(id, status, errMsg string, recipientCount int) error {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_, err := s.db.Exec(ctx, `
		UPDATE broadcasts
		SET status = $2, error = NULLIF($3,''),
		    recipient_count = CASE WHEN $4 > 0 THEN $4 ELSE recipient_count END,
		    sent_at = CASE WHEN $2 = 'sent' THEN now() ELSE sent_at END
		WHERE id = $1`, id, status, errMsg, recipientCount)
	return err
}

func (s *postgresStore) ListActiveSubscribers() ([]Subscriber, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	rows, err := s.db.Query(ctx,
		`SELECT id::text, email FROM subscriptions WHERE unsubscribed_at IS NULL ORDER BY created_at`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Subscriber
	for rows.Next() {
		var sub Subscriber
		if err := rows.Scan(&sub.ID, &sub.Email); err != nil {
			return nil, err
		}
		out = append(out, sub)
	}
	return out, rows.Err()
}
