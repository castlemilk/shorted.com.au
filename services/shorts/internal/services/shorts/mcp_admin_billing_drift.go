package shorts

// mcp_admin_billing_drift.go: the decisions behind the billing audit, as pure
// functions over the mirror rows and the Stripe views. No I/O here, so every
// rule is a table test.
//
// Two rules hold throughout:
//
//   - Entitlement is ResolveEntitlement, never restated. Every "does this row
//     grant paid access" question goes through it.
//   - A row updated in the last billingRecentWindow is left out of every
//     comparison. The webhook that wrote it may still be in flight, and a
//     mismatch that is about to heal is not a finding.

import (
	"sort"
	"strings"
	"time"

	"github.com/castlemilk/shorted.com.au/services/shorts/internal/mcp"
	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
)

const (
	billingRecentWindow    = 15 * time.Minute
	billingPeriodTolerance = time.Hour
)

// Finding kinds. Mirror-only kinds need no Stripe; the rest need a Stripe read.
const (
	kindPaidWithoutMirror     = "paid_without_mirror"
	kindEntitledWithoutStripe = "entitled_without_stripe"
	kindStatusMismatch        = "status_mismatch"
	kindPeriodEndMismatch     = "period_end_mismatch"
	kindCancelMismatch        = "cancel_mismatch"
	kindMissingPeriodEnd      = "missing_period_end"
	kindPastDue               = "past_due"
	kindPeriodEnded           = "period_ended"
	kindUnpaidTier            = "unpaid_tier"
	kindEmailKeyedUserID      = "email_keyed_user_id"
	kindDuplicateEmail        = "duplicate_email"
)

// kindSeverity orders findings: money taken with no access first, then access
// with no money, then the mirror's own state, then the tidy-ups.
var kindSeverity = map[string]int{
	kindPaidWithoutMirror:     0,
	kindEntitledWithoutStripe: 1,
	kindPeriodEnded:           2,
	kindUnpaidTier:            3,
	kindPastDue:               4,
	kindStatusMismatch:        5,
	kindPeriodEndMismatch:     6,
	kindCancelMismatch:        7,
	kindMissingPeriodEnd:      8,
	kindEmailKeyedUserID:      9,
	kindDuplicateEmail:        10,
}

// stripeCustomerView is one Stripe customer as read through the web app. The
// customer id is kept for matching only; the output never carries it.
type stripeCustomerView struct {
	customerID string
	lookedUpBy string
	created    *string
	subs       []webSubscription
	invoice    *webInvoice
}

// isRecentlyUpdated reports whether the row was written within the window,
// including a timestamp ahead of now (clock skew must not make a row look old).
func isRecentlyUpdated(r shortsstore.BillingSubscription, now time.Time) bool {
	return r.UpdatedAt != nil && !r.UpdatedAt.Before(now.Add(-billingRecentWindow))
}

// isLiveStripe is the set Stripe calls live: it still bills or still owes.
func isLiveStripe(status string) bool {
	switch status {
	case "active", "trialing", "past_due", "unpaid":
		return true
	}
	return false
}

// mirrorStatusFor maps a Stripe status to the value the webhook writes. The
// mapping is the webhook's own: unpaid is recorded as past_due, and an
// incomplete or paused subscription as inactive.
func mirrorStatusFor(stripe string) string {
	switch {
	case stripe == "unpaid":
		return "past_due"
	case strings.HasPrefix(stripe, "incomplete"), stripe == "paused":
		return "inactive"
	}
	return stripe
}

// parsePeriod reads a period bound as the store returns it.
func parsePeriod(text *string) (time.Time, bool) {
	if text == nil {
		return time.Time{}, false
	}
	return parseStoreTimestamp(*text)
}

// rowsForStripeSub returns the mirror rows that track a Stripe subscription.
// A row tracks it by subscription id; a live subscription is also tracked by a
// row on the same customer that has no subscription id yet (the checkout
// webhook wrote the customer first).
func rowsForStripeSub(rows []shortsstore.BillingSubscription, customerID string, s webSubscription) []shortsstore.BillingSubscription {
	var byID, byCustomer []shortsstore.BillingSubscription
	for _, r := range rows {
		switch {
		case s.ID != "" && r.StripeSubscriptionID == s.ID:
			byID = append(byID, r)
		case isLiveStripe(s.Status) && r.StripeSubscriptionID == "" && customerID != "" && r.StripeCustomerID == customerID:
			byCustomer = append(byCustomer, r)
		}
	}
	if len(byID) > 0 {
		return byID
	}
	return byCustomer
}

// rowIsLiveInStripe reports whether Stripe has a live subscription for the row:
// the row's own subscription, or any live subscription on its customer.
func rowIsLiveInStripe(r shortsstore.BillingSubscription, views []stripeCustomerView) bool {
	for _, v := range views {
		for _, s := range v.subs {
			if !isLiveStripe(s.Status) {
				continue
			}
			if r.StripeSubscriptionID != "" && s.ID == r.StripeSubscriptionID {
				return true
			}
			if r.StripeCustomerID != "" && v.customerID == r.StripeCustomerID {
				return true
			}
		}
	}
	return false
}

// billingDrift compares one subject's mirror rows with the Stripe customers
// read for them. stripeOK is false when Stripe was not fully read: the
// Stripe-dependent checks are then skipped, never guessed. It returns the
// findings, most severe first, and the emails of the rows left out as recent.
func billingDrift(now time.Time, rows []shortsstore.BillingSubscription, views []stripeCustomerView, stripeOK bool) ([]mcp.BillingDriftFinding, []string) {
	var findings []mcp.BillingDriftFinding
	add := func(kind, detail string) {
		findings = append(findings, mcp.BillingDriftFinding{Kind: kind, Detail: detail})
	}

	var eligible []shortsstore.BillingSubscription
	var skipped []string
	for _, r := range rows {
		if isRecentlyUpdated(r, now) {
			skipped = append(skipped, r.UserEmail)
			continue
		}
		eligible = append(eligible, r)
	}

	// Mirror-only: no Stripe needed.
	perEmail := map[string]int{}
	for _, r := range eligible {
		perEmail[strings.ToLower(r.UserEmail)]++
	}
	flaggedMissingPeriod := map[string]bool{}
	for _, r := range eligible {
		if strings.Contains(r.UserID, "@") {
			add(kindEmailKeyedUserID, "the row is keyed by an email address, which no Firebase account can match; the user it belongs to can never be entitled through it")
		}
		if perEmail[strings.ToLower(r.UserEmail)] > 1 {
			add(kindDuplicateEmail, "this email has more than one mirror row")
		}
	}

	if stripeOK {
		// Every live Stripe subscription should be tracked by a row.
		for _, v := range views {
			for _, s := range v.subs {
				matched := rowsForStripeSub(rows, v.customerID, s)
				if len(matched) == 0 {
					if isLiveStripe(s.Status) {
						add(kindPaidWithoutMirror, "Stripe has a "+s.Status+" "+s.Tier+" subscription that no mirror row tracks")
					}
					continue
				}
				r := matched[0]
				if isRecentlyUpdated(r, now) {
					continue
				}
				if want := mirrorStatusFor(s.Status); r.Status != want {
					add(kindStatusMismatch, "the mirror says "+r.Status+", Stripe says "+s.Status)
				}
				if s.CurrentPeriodEnd != nil {
					stripeEnd, ok := parsePeriod(s.CurrentPeriodEnd)
					switch mirrorEnd, mirrorOK := parsePeriod(r.CurrentPeriodEnd); {
					case r.CurrentPeriodEnd == nil:
						add(kindMissingPeriodEnd, "Stripe has a current period end ("+periodLabel(stripeEnd, ok)+"); the mirror has none")
						flaggedMissingPeriod[r.UserID] = true
					case ok && mirrorOK && mirrorEnd.Sub(stripeEnd).Abs() > billingPeriodTolerance:
						add(kindPeriodEndMismatch, "the mirror ends "+periodLabel(mirrorEnd, true)+", Stripe ends "+periodLabel(stripeEnd, ok))
					}
				}
				if r.CancelAtPeriodEnd != s.CancelAtPeriodEnd {
					add(kindCancelMismatch, "the mirror has cancel at period end set to "+boolLabel(r.CancelAtPeriodEnd)+", Stripe "+boolLabel(s.CancelAtPeriodEnd))
				}
			}
		}
		// A row that grants paid access from Stripe must have a live Stripe
		// subscription behind it.
		for _, r := range eligible {
			ent := ResolveEntitlement(r.UserID, r.APISubscription(), now)
			if !ent.Entitled || ent.Source != "stripe" || rowIsLiveInStripe(r, views) {
				continue
			}
			add(kindEntitledWithoutStripe, "the mirror grants paid access ("+ent.Reason+") but Stripe has no live subscription for this customer")
		}
	}

	// A paying-looking row with no period end, when Stripe was not asked.
	for _, r := range eligible {
		if r.Status == "active" && r.CurrentPeriodEnd == nil && !flaggedMissingPeriod[r.UserID] {
			add(kindMissingPeriodEnd, "the row is active with no current period end")
		}
	}

	sortFindings(findings)
	return findings, skipped
}

func sortFindings(findings []mcp.BillingDriftFinding) {
	sort.SliceStable(findings, func(i, j int) bool {
		return kindSeverity[findings[i].Kind] < kindSeverity[findings[j].Kind]
	})
}

func periodLabel(t time.Time, ok bool) string {
	if !ok {
		return "unknown"
	}
	return t.UTC().Format(time.RFC3339)
}

func boolLabel(b bool) string {
	if b {
		return "true"
	}
	return "false"
}

// --- list_billing_exceptions ------------------------------------------------

// exceptionInput is one sweep over every mirror row, and the live Stripe list
// when it could be read.
type exceptionInput struct {
	Now            time.Time
	Rows           []shortsstore.BillingSubscription
	Alive          []webAliveSubscription
	AliveOK        bool
	AliveTruncated bool
}

// exceptionResult is the sweep's findings, most severe first, with the counts
// of every kind the sweep checked.
type exceptionResult struct {
	Findings      []mcp.BillingExceptionRow
	Counts        map[string]int
	SkippedRecent int
	Notes         []string
}

// billingExceptions finds the exceptions across every subscriber.
func billingExceptions(in exceptionInput) exceptionResult {
	res := exceptionResult{Counts: map[string]int{}}
	add := func(kind, email, uid, detail string) {
		res.Findings = append(res.Findings, mcp.BillingExceptionRow{Kind: kind, Email: email, UserID: uid, Detail: detail})
		res.Counts[kind]++
	}

	var eligible []shortsstore.BillingSubscription
	for _, r := range in.Rows {
		if isRecentlyUpdated(r, in.Now) {
			res.SkippedRecent++
			continue
		}
		eligible = append(eligible, r)
	}

	perEmail := map[string]int{}
	for _, r := range eligible {
		perEmail[strings.ToLower(r.UserEmail)]++
	}

	// Each eligible row's verdict, computed once.
	verdicts := make(map[string]Entitlement, len(eligible))
	for _, r := range eligible {
		verdicts[r.UserID] = ResolveEntitlement(r.UserID, r.APISubscription(), in.Now)
	}

	// Every kind this sweep checks is present in counts, zero included, so an
	// absent kind always means "not checked". The Stripe kinds are added only
	// when the live list was read; entitled_without_stripe also needs the list
	// whole, since a cut list cannot show a customer has no live subscription.
	for _, kind := range []string{kindPastDue, kindPeriodEnded, kindUnpaidTier, kindMissingPeriodEnd, kindEmailKeyedUserID, kindDuplicateEmail} {
		res.Counts[kind] = 0
	}
	stripeChecked := in.AliveOK && !in.AliveTruncated
	if in.AliveOK {
		res.Counts[kindPaidWithoutMirror] = 0
	}
	if stripeChecked {
		res.Counts[kindEntitledWithoutStripe] = 0
	}

	for _, r := range eligible {
		v := verdicts[r.UserID]
		if r.Status == "past_due" {
			add(kindPastDue, r.UserEmail, r.UserID, "payment failed; the row is past_due and grants no paid access")
		}
		if v.Reason == "period_ended" {
			add(kindPeriodEnded, r.UserEmail, r.UserID, "the row is "+r.Status+" but its period ended more than 24 hours ago; Stripe has not renewed it on this row")
		}
		if v.Reason == "unpaid_tier" {
			add(kindUnpaidTier, r.UserEmail, r.UserID, "the row is "+r.Status+" on tier "+r.Tier+", which carries no paid features")
		}
		if r.Status == "active" && r.CurrentPeriodEnd == nil {
			add(kindMissingPeriodEnd, r.UserEmail, r.UserID, "the row is active with no current period end, so its entitlement cannot be checked against time")
		}
		if strings.Contains(r.UserID, "@") {
			add(kindEmailKeyedUserID, r.UserEmail, r.UserID, "the row is keyed by an email address, which no Firebase account can match")
		}
		if perEmail[strings.ToLower(r.UserEmail)] > 1 {
			add(kindDuplicateEmail, r.UserEmail, r.UserID, "this email has more than one mirror row")
		}
		if stripeChecked && v.Entitled && v.Source == "stripe" && !rowIsLiveInAlive(r, in.Alive) {
			add(kindEntitledWithoutStripe, r.UserEmail, r.UserID, "the mirror grants paid access ("+v.Reason+") but Stripe has no live subscription for this customer")
		}
	}

	if in.AliveOK {
		for _, a := range in.Alive {
			matched, found := matchAliveRow(in.Rows, a)
			switch {
			case !found:
				add(kindPaidWithoutMirror, a.Email, a.MetadataUserID, "Stripe has a "+a.Status+" subscription that no mirror row tracks")
			case isRecentlyUpdated(matched, in.Now):
				res.SkippedRecent++
			case (a.Status == "active" || a.Status == "trialing") && !verdicts[matched.UserID].Entitled:
				add(kindPaidWithoutMirror, a.Email, matched.UserID, "Stripe says "+a.Status+" but the mirror row grants no paid access ("+verdicts[matched.UserID].Reason+")")
			}
		}
	}

	sort.SliceStable(res.Findings, func(i, j int) bool {
		fi, fj := res.Findings[i], res.Findings[j]
		if si, sj := kindSeverity[fi.Kind], kindSeverity[fj.Kind]; si != sj {
			return si < sj
		}
		if fi.Email != fj.Email {
			return fi.Email < fj.Email
		}
		return fi.UserID < fj.UserID
	})
	return res
}

// matchAliveRow finds the mirror row a live Stripe subscription belongs to: by
// subscription id, else by the user id Stripe was told at checkout, else (only
// when that user id is empty) by email. Rows are newest first, so the most
// recent of several email matches is the one taken.
func matchAliveRow(rows []shortsstore.BillingSubscription, a webAliveSubscription) (shortsstore.BillingSubscription, bool) {
	if a.SubscriptionID != "" {
		for _, r := range rows {
			if r.StripeSubscriptionID == a.SubscriptionID {
				return r, true
			}
		}
	}
	if a.MetadataUserID != "" {
		for _, r := range rows {
			if r.UserID == a.MetadataUserID {
				return r, true
			}
		}
		return shortsstore.BillingSubscription{}, false
	}
	for _, r := range rows {
		if a.Email != "" && strings.EqualFold(r.UserEmail, a.Email) {
			return r, true
		}
	}
	return shortsstore.BillingSubscription{}, false
}

// rowIsLiveInAlive is rowIsLiveInStripe for the alive list.
func rowIsLiveInAlive(r shortsstore.BillingSubscription, alive []webAliveSubscription) bool {
	for _, a := range alive {
		if r.StripeSubscriptionID != "" && a.SubscriptionID == r.StripeSubscriptionID {
			return true
		}
		if r.StripeCustomerID != "" && a.CustomerID == r.StripeCustomerID {
			return true
		}
	}
	return false
}
