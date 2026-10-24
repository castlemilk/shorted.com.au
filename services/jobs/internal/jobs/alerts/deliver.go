package alerts

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/castlemilk/shorted.com.au/services/pkg/resend"
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
}

// deliveryStats is what one delivery pass did.
type deliveryStats struct {
	claimed       int
	sent          int
	retrying      int
	failed        int
	skippedPaused int
	canary        string // ok, failed or skipped
	canaryID      string
	quota         bool // Resend's quota ran out; the rest were returned to pending
}

// wantCanary decides whether this pass sends the canary. auto sends one when mail
// is about to go out, and otherwise once a day. always sends every pass, and off
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
		if err := sendCanary(ctx, st, client, env, o.runID, &stats); err != nil {
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

		r, err := renderMessage(env.siteURL, env.unsubscribeSecret, c.monitorID, c.msg)
		if err != nil {
			if err := st.markFailed(ctx, c.id, "render: "+err.Error()); err != nil {
				return stats, err
			}
			stats.failed++
			continue
		}
		email := toEmail(r, env.from, env.replyTo, c.email)
		resendID, sendErr := client.Send(ctx, email, fmt.Sprintf("alert-event-%d", c.id))
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
func sendCanary(ctx context.Context, st store, client *resend.Client, env settings, runID int64, stats *deliveryStats) error {
	r, err := renderMessage(env.siteURL, env.unsubscribeSecret, canaryMonitorID, canaryMessage())
	if err != nil {
		stats.canary = "failed"
		return err
	}
	id, err := client.Send(ctx, toEmail(r, env.from, env.replyTo, env.canaryTo), fmt.Sprintf("alert-canary-%d", runID))
	if err != nil {
		stats.canary = "failed"
		return err
	}
	stats.canary = "ok"
	stats.canaryID = id
	return st.markCanarySent(ctx)
}

// toEmail assembles the Resend body for one recipient.
func toEmail(r rendered, from, replyTo, to string) resend.Email {
	return resend.Email{
		From:    from,
		To:      []string{to},
		ReplyTo: replyTo,
		Subject: r.Subject,
		HTML:    r.HTML,
		Text:    r.Text,
		Headers: r.Headers,
		Tags:    r.Tags,
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
	var se *resend.SendError
	if errors.As(err, &se) {
		return se.Error()
	}
	return "send failed"
}
