//go:build integration

package shorts

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// The feedback write runs against the real alert tables (000074, 000147, 000148 applied
// twice, as the deploy replays them), so the UPDATE, the suppression insert and
// the replay behaviour are all exercised on Postgres.
func TestRecordResendFeedbackMarksDeliveryAndSuppresses(t *testing.T) {
	s := alertsTestStore(t)
	ctx := context.Background()

	monitor := alertsTestMonitor(t, s, "owner-1", "AAA")
	insertAlertEvent(t, s, monitor.ID, "2026-10-14", "2026-10-13", "sent")
	_, err := s.db.Exec(ctx, `UPDATE alert_events SET resend_id = 'em_bounce' WHERE monitor_id = $1`, monitor.ID)
	require.NoError(t, err)

	// A permanent bounce: the delivery is marked and the address, lower-cased, suppressed.
	res, err := s.RecordResendFeedback(ctx, "em_bounce", "bounced", "bounced", []string{"  Ops@Corp.example "})
	require.NoError(t, err)
	assert.EqualValues(t, 1, res.Deliveries)
	assert.Equal(t, []string{"ops@corp.example"}, res.NewlySuppressed)

	var status string
	require.NoError(t, s.db.QueryRow(ctx, `SELECT email_status FROM alert_events WHERE monitor_id = $1`, monitor.ID).Scan(&status))
	assert.Equal(t, "bounced", status)

	var reason, emailID string
	require.NoError(t, s.db.QueryRow(ctx,
		`SELECT reason, resend_email_id FROM alert_email_suppressions WHERE email = 'ops@corp.example'`).Scan(&reason, &emailID))
	assert.Equal(t, "bounced", reason)
	assert.Equal(t, "em_bounce", emailID)

	// Replaying the same webhook changes nothing and reports no new suppression, so
	// the operator is not told twice.
	res, err = s.RecordResendFeedback(ctx, "em_bounce", "bounced", "bounced", []string{"ops@corp.example"})
	require.NoError(t, err)
	assert.EqualValues(t, 1, res.Deliveries)
	assert.Empty(t, res.NewlySuppressed)
}

func TestRecordResendFeedbackComplaintAndNonAlertEmail(t *testing.T) {
	s := alertsTestStore(t)
	ctx := context.Background()

	monitor := alertsTestMonitor(t, s, "owner-2", "BBB")
	insertAlertEvent(t, s, monitor.ID, "2026-10-14", "2026-10-13", "sent")
	_, err := s.db.Exec(ctx, `UPDATE alert_events SET resend_id = 'em_spam' WHERE monitor_id = $1`, monitor.ID)
	require.NoError(t, err)

	// A complaint on an alert: marked complained, suppressed under the complained reason.
	res, err := s.RecordResendFeedback(ctx, "em_spam", "complained", "complained", []string{"spam@corp.example"})
	require.NoError(t, err)
	assert.EqualValues(t, 1, res.Deliveries)
	assert.Equal(t, []string{"spam@corp.example"}, res.NewlySuppressed)

	var status string
	require.NoError(t, s.db.QueryRow(ctx, `SELECT email_status FROM alert_events WHERE monitor_id = $1`, monitor.ID).Scan(&status))
	assert.Equal(t, "complained", status)

	// An email that is not an alert (a broadcast) matches no delivery but still
	// suppresses the address, so alerts stop going to it too.
	res, err = s.RecordResendFeedback(ctx, "em_broadcast", "bounced", "bounced", []string{"newsletter@corp.example"})
	require.NoError(t, err)
	assert.EqualValues(t, 0, res.Deliveries)
	assert.Equal(t, []string{"newsletter@corp.example"}, res.NewlySuppressed)

	counts, err := s.AdminAlertDeliveryHealth(ctx)
	require.NoError(t, err)
	assert.EqualValues(t, 0, counts.Bounced)
	assert.EqualValues(t, 1, counts.Complained)
	assert.EqualValues(t, 2, counts.Suppressed)
}

func TestRecordResendFeedbackRequiresStatusAndReason(t *testing.T) {
	s := alertsTestStore(t)
	_, err := s.RecordResendFeedback(context.Background(), "em_x", "", "", []string{"a@example.com"})
	assert.Error(t, err)
}
