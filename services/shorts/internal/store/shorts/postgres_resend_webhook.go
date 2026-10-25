package shorts

// postgres_resend_webhook.go: the write side of Resend's delivery feedback. A
// hard bounce or a complaint marks the alert delivery that sent the email and
// suppresses the address from later alert sends, in one transaction. Migration
// 000148 holds alert_email_suppressions and widens alert_events.email_status.

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
)

// ResendFeedbackResult says what one feedback event changed.
type ResendFeedbackResult struct {
	// Deliveries is the number of alert_events rows whose resend_id is the email.
	// Zero for an email that was not an alert, such as a broadcast.
	Deliveries int64
	// NewlySuppressed are the addresses this event suppressed. An address that was
	// already suppressed is not repeated, so the operator is told once.
	NewlySuppressed []string
}

// RecordResendFeedback marks the alert delivery for emailID as status (bounced or
// complained) and suppresses each address under reason. Both writes share a
// transaction, so a suppression never exists without its delivery being marked,
// and a retried webhook changes nothing the second time.
func (s *postgresStore) RecordResendFeedback(ctx context.Context, emailID, status, reason string, addresses []string) (ResendFeedbackResult, error) {
	var out ResendFeedbackResult
	if status == "" || reason == "" {
		return out, errors.New("feedback needs a status and a reason")
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return out, fmt.Errorf("begin feedback: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if emailID != "" {
		tag, err := tx.Exec(ctx, `
			UPDATE alert_events
			   SET email_status = $2, last_error = $3, updated_at = now()
			 WHERE resend_id = $1`, emailID, status, "resend: "+status)
		if err != nil {
			return out, fmt.Errorf("mark alert delivery: %w", err)
		}
		out.Deliveries = tag.RowsAffected()
	}

	for _, raw := range addresses {
		email := strings.ToLower(strings.TrimSpace(raw))
		if email == "" {
			continue
		}
		var added string
		err := tx.QueryRow(ctx, `
			INSERT INTO alert_email_suppressions (email, reason, resend_email_id)
			VALUES ($1, $2, NULLIF($3, ''))
			ON CONFLICT (email) DO NOTHING
			RETURNING email`, email, reason, emailID).Scan(&added)
		if errors.Is(err, pgx.ErrNoRows) {
			continue
		}
		if err != nil {
			return out, fmt.Errorf("suppress address: %w", err)
		}
		out.NewlySuppressed = append(out.NewlySuppressed, added)
	}

	if err := tx.Commit(ctx); err != nil {
		return ResendFeedbackResult{}, fmt.Errorf("commit feedback: %w", err)
	}
	return out, nil
}

// AlertDeliveryHealth counts the feedback the admin MCP server reports: alert
// deliveries Resend later bounced or complained about, and suppressed addresses.
// Counts only, across every owner.
type AlertDeliveryHealth struct {
	Bounced    int64
	Complained int64
	Suppressed int64
}

// AdminAlertDeliveryHealth reads the counts. It names no owner and no address.
func (s *postgresStore) AdminAlertDeliveryHealth(ctx context.Context) (AlertDeliveryHealth, error) {
	var out AlertDeliveryHealth
	err := s.db.QueryRow(ctx, `
		SELECT
		  (SELECT count(*) FROM alert_events WHERE email_status = 'bounced'),
		  (SELECT count(*) FROM alert_events WHERE email_status = 'complained'),
		  (SELECT count(*) FROM alert_email_suppressions)`).
		Scan(&out.Bounced, &out.Complained, &out.Suppressed)
	if err != nil {
		return out, fmt.Errorf("count alert delivery feedback: %w", err)
	}
	return out, nil
}
