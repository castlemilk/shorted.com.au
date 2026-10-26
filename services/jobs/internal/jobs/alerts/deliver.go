package alerts

import (
	"context"
	"errors"
	"fmt"
	"time"

	"connectrpc.com/connect"

	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	shortsv1alpha1connect "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1/shortsv1alpha1connect"
	"github.com/castlemilk/shorted.com.au/services/pkg/alertevents"
	"github.com/castlemilk/shorted.com.au/services/pkg/resend"
	"github.com/castlemilk/shorted.com.au/services/pkg/unsubscribe"
)

// maxAttempts is how many sends a row gets before it is failed for good. A claim
// counts as an attempt, whatever its outcome.
const maxAttempts = 3

var (
	// errCanaryRejected stops a run before any customer mail goes out. The canary
	// is the preflight, so a rejected canary means the sending path is broken.
	errCanaryRejected = errors.New("canary rejected: customer email held for the next run")
	// errCredential stops a run when Resend refuses the key.
	errCredential = errors.New("resend rejected the API key: sending stopped")
)

// deliverOpts is what one delivery pass needs from the run.
type deliverOpts struct {
	canaryMode string
	canaryDue  bool
	maxSends   int
	rps        float64
	userID     string // a replay's owner, or "" for every owner
	runID      int64
	runStarted time.Time
	// pauseClient proves the one-click pause path before a canary goes out.
	pauseClient shortsv1alpha1connect.AlertsServiceClient
}

// deliveryStats is what one delivery pass did.
type deliveryStats struct {
	claimed       int
	sent          int
	retrying      int
	failed        int
	skippedPaused int
	// skippedSuppressed counts alerts not sent because the address bounced or complained.
	skippedSuppressed int
	canary            string // ok, failed or skipped
	canaryID          string
	quota             bool // Resend's quota ran out; the rest were returned to pending
}

// idempotencyKey names one email to Resend. Resend holds a key for 24 hours across
// the whole account, and that account also sends from test databases and other
// products, so a bare row id is not unique: prod's first run reused
// "alert-canary-1" from a test run earlier that day, and Resend refused it with
// 409 invalid_idempotent_request. The row's creation time, read back from the
// database on every attempt, keeps the key the same for a retry of one row and
// different between databases.
func idempotencyKey(kind string, id int64, created time.Time) string {
	return fmt.Sprintf("alert-%s-%d-%d", kind, id, created.UnixMicro())
}

// wantCanary decides whether this pass sends the canary. auto sends one when mail
// is about to go out, and otherwise at least every 20 hours. always sends every pass, and off
// never does.
func wantCanary(mode string, claimed int, due bool) bool {
	switch mode {
	case canaryAlways:
		return true
	case canaryAuto:
		return claimed > 0 || due
	}
	return false
}

// deliver runs one pass: stale recovery, expiry, the claim, the canary, and then
// one send per claimed row. It returns errCanaryRejected or errCredential when the
// run must stop with exit 1. A quota stop is reported in stats, not as an error.
func deliver(ctx context.Context, st store, client *resend.Client, env settings, o deliverOpts) (deliveryStats, error) {
	stats := deliveryStats{canary: "skipped"}
	if err := st.recoverStale(ctx); err != nil {
		return stats, err
	}
	if err := st.expirePending(ctx); err != nil {
		return stats, err
	}
	rows, err := st.claim(ctx, o.maxSends, o.userID)
	if err != nil {
		return stats, err
	}
	stats.claimed = len(rows)

	if wantCanary(o.canaryMode, len(rows), o.canaryDue) {
		if err := sendCanary(ctx, st, client, env, o.pauseClient, o.runID, o.runStarted, &stats); err != nil {
			ids := make([]int64, 0, len(rows))
			for _, c := range rows {
				ids = append(ids, c.id)
			}
			if rerr := st.returnToPending(ctx, ids); rerr != nil {
				return stats, fmt.Errorf("%w (and returning claims failed: %v)", errCanaryRejected, rerr)
			}
			return stats, fmt.Errorf("%w: %s", errCanaryRejected, describeSendError(err))
		}
	}

	charts := newChartMemo()
	var tick <-chan time.Time
	if o.rps > 0 {
		t := time.NewTicker(time.Duration(float64(time.Second) / o.rps))
		defer t.Stop()
		tick = t.C
	}
	for i, c := range rows {
		if i > 0 && tick != nil {
			select {
			case <-ctx.Done():
				return stats, ctx.Err()
			case <-tick:
			}
		}
		switch {
		case c.monStatus != "active":
			// Paused since evaluation. A monitor that is gone has cascaded its
			// events away, so this branch is reached only by a race.
			if err := st.markSkipped(ctx, c.id, "skipped_paused"); err != nil {
				return stats, err
			}
			stats.skippedPaused++
			continue
		case c.email == "":
			if err := st.markSkipped(ctx, c.id, "skipped_no_email"); err != nil {
				return stats, err
			}
			continue
		}
		// A hard bounce or a complaint on this address (Resend webhook, migration 000148)
		// blocks every later alert to it. Checked per send, so a bounce that arrives
		// while the batch is running still stops the rest of that address's alerts.
		suppressed, err := st.isSuppressed(ctx, c.email)
		if err != nil {
			return stats, err
		}
		if suppressed {
			if err := st.markSkipped(ctx, c.id, alertevents.StatusSkippedSuppressed); err != nil {
				return stats, err
			}
			stats.skippedSuppressed++
			continue
		}

		r, err := renderMessageCharts(charts, env.siteURL, env.unsubscribeSecret, c.monitorID, c.msg)
		if err != nil {
			if err := st.markFailed(ctx, c.id, "render: "+err.Error()); err != nil {
				return stats, err
			}
			stats.failed++
			continue
		}
		email := toEmail(r, env.from, env.replyTo, c.email)
		resendID, sendErr := client.Send(ctx, email, idempotencyKey("event", c.id, c.createdAt))
		if sendErr == nil {
			if err := st.markSent(ctx, c.id, resendID); err != nil {
				return stats, err
			}
			stats.sent++
			continue
		}

		var se *resend.SendError
		if !errors.As(sendErr, &se) {
			// A context error. The row stays claimed, and stale recovery will
			// put it back within the 23-hour window.
			return stats, sendErr
		}
		switch se.Kind {
		case resend.KindCredential:
			if err := st.returnToPending(ctx, idsFrom(rows, i)); err != nil {
				return stats, err
			}
			return stats, fmt.Errorf("%w: %s", errCredential, se.Error())
		case resend.KindQuota:
			if err := st.returnToPending(ctx, idsFrom(rows, i)); err != nil {
				return stats, err
			}
			stats.quota = true
			return stats, nil
		case resend.KindPermanent:
			if err := st.markFailed(ctx, c.id, se.Error()); err != nil {
				return stats, err
			}
			stats.failed++
		default: // retryable or rate limited
			if c.attempts >= maxAttempts {
				if err := st.markFailed(ctx, c.id, fmt.Sprintf("gave up after %d attempts: %s", c.attempts, se.Error())); err != nil {
					return stats, err
				}
				stats.failed++
				continue
			}
			if err := st.markRetry(ctx, c.id, se.Error()); err != nil {
				return stats, err
			}
			stats.retrying++
		}
	}
	return stats, nil
}

// sendCanary sends the fixed stock-above fixture through the same template, key,
// sender and headers as a customer email. A success is recorded as the day's
// proof. The key is per run, so a retry of the same run does not send twice.
func sendCanary(ctx context.Context, st store, client *resend.Client, env settings, pause shortsv1alpha1connect.AlertsServiceClient, runID int64, runStarted time.Time, stats *deliveryStats) error {
	if err := verifyPauseLink(ctx, pause, env.unsubscribeSecret); err != nil {
		stats.canary = "failed"
		return err
	}
	r, err := renderMessage(env.siteURL, env.unsubscribeSecret, canaryMonitorID, canaryMessage())
	if err != nil {
		stats.canary = "failed"
		return err
	}
	id, err := client.Send(ctx, toEmail(r, env.from, env.replyTo, env.canaryTo), idempotencyKey("canary", runID, runStarted))
	if err != nil {
		stats.canary = "failed"
		return err
	}
	stats.canary = "ok"
	stats.canaryID = id
	return st.markCanarySent(ctx)
}

// verifyPauseLink proves the one-click pause path before customer mail goes out.
// The canary's token names no real monitor, so the API must answer NotFound. An
// answer of InvalidArgument means the token did not verify, which is what a rotated
// UNSUBSCRIBE_SECRET looks like from here: the job still holds the old copy. Any
// other answer means the path is not working either. Each fails the canary.
func verifyPauseLink(ctx context.Context, pause shortsv1alpha1connect.AlertsServiceClient, secret string) error {
	if pause == nil {
		return errors.New("pause link: no API client")
	}
	token := unsubscribe.AlertMonitorToken(canaryMonitorID, secret)
	_, err := pause.PauseAlertMonitorByToken(ctx, connect.NewRequest(&shortsv1alpha1.PauseAlertMonitorByTokenRequest{Token: token}))
	if err == nil {
		// The canary id is all zeros and is never a real monitor. An answer of
		// success would mean something paused a monitor it should not have.
		return errors.New("pause link: the canary monitor unexpectedly exists")
	}
	if connect.CodeOf(err) == connect.CodeNotFound {
		return nil
	}
	return fmt.Errorf("pause link round trip: %s", connect.CodeOf(err))
}

// toEmail assembles the Resend body for one recipient.
func toEmail(r rendered, from, replyTo, to string) resend.Email {
	return resend.Email{
		From:        from,
		To:          []string{to},
		ReplyTo:     replyTo,
		Subject:     r.Subject,
		HTML:        r.HTML,
		Text:        r.Text,
		Headers:     r.Headers,
		Tags:        r.Tags,
		Attachments: r.Attachments,
	}
}

// idsFrom returns the ids of rows from index i to the end.
func idsFrom(rows []claimed, i int) []int64 {
	ids := make([]int64, 0, len(rows)-i)
	for _, c := range rows[i:] {
		ids = append(ids, c.id)
	}
	return ids
}

// describeSendError is the log form of a send error. It holds the kind and status,
// never a recipient address or a response body.
func describeSendError(err error) string {
	if se, ok := errors.AsType[*resend.SendError](err); ok {
		return se.Error()
	}
	return "send failed"
}
