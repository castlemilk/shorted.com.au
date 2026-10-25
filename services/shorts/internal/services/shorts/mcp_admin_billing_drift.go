package shorts

// mcp_admin_billing_drift.go: the decisions behind the billing audit, as pure
// functions over the mirror rows and the Stripe views. No I/O here, so every
// rule is a table test.
//
// Three rules hold throughout:
//
//   - The unit is the CUSTOMER. api_subscriptions has one row per Stripe customer
//     (stripe_customer_id is UNIQUE), and the web sync writes the customer's best
//     subscription onto it. So a row is compared with the customer's best
//     subscription, chosen by the same ranking the web uses (bestStripeSubscription),
//     and never with "the subscription this event named".
//   - Entitlement is the product's rule (ResolveEntitlement), never restated. The
//     one exception is a null status, which the product cannot read at all, so it
//     is reported as its own reason rather than guessed.
//   - A row updated in the last billingRecentWindow is left out of every
//     comparison. The webhook that wrote it may still be in flight, and a mismatch
//     that is about to heal is not a finding.

import (
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/castlemilk/shorted.com.au/services/shorts/internal/mcp"
	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
)

const (
	billingRecentWindow    = 15 * time.Minute
	billingPeriodTolerance = time.Hour
)

// Finding kinds. A kind's name is the contract the tools publish; the severity
// order below decides how the lists are sorted.
const (
	kindPaidWithoutMirror        = "paid_without_mirror"
	kindSubscriptionUserMismatch = "subscription_user_mismatch"
	kindUnpaidWithoutMirror      = "unpaid_without_mirror"
	kindEntitledWithoutStripe    = "entitled_without_stripe"
	kindStaleSubscriptionID      = "stale_subscription_id"
	kindStatusMismatch           = "status_mismatch"
	kindPeriodEndMismatch        = "period_end_mismatch"
	kindCancelMismatch           = "cancel_mismatch"
	kindMissingPeriodEnd         = "missing_period_end"
	kindNullStatus               = "null_status"
	kindPastDue                  = "past_due"
	kindPeriodEnded              = "period_ended"
	kindUnpaidTier               = "unpaid_tier"
	kindEmailKeyedUserID         = "email_keyed_user_id"
	kindDuplicateEmail           = "duplicate_email"
)

// kindSeverity orders findings: money taken with no access first, then access with
// no money, then the mirror's own state, then the tidy-ups. A stale subscription
// id is low: the state it should describe is already right.
var kindSeverity = map[string]int{
	kindPaidWithoutMirror:        0,
	kindSubscriptionUserMismatch: 1,
	kindEntitledWithoutStripe:    2,
	kindUnpaidWithoutMirror:      3,
	kindPeriodEnded:              4,
	kindUnpaidTier:               5,
	kindPastDue:                  6,
	kindNullStatus:               7,
	kindStatusMismatch:           8,
	kindPeriodEndMismatch:        9,
	kindCancelMismatch:           10,
	kindStaleSubscriptionID:      11,
	kindMissingPeriodEnd:         12,
	kindEmailKeyedUserID:         13,
	kindDuplicateEmail:           14,
}

// liveRank is the web's preference order among live subscriptions (its LIVE_RANK).
// A status not listed is ended and ranks after all of these.
var liveRank = []string{"active", "trialing", "past_due", "unpaid"}

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

// stripeRank orders one Stripe status the way the web's pickBestSubscription does
// (lower is better). Every ended status shares the last rank.
func stripeRank(status string) int {
	s := normaliseRowValue(status)
	for i, live := range liveRank {
		if s == live {
			return i
		}
	}
	return len(liveRank)
}

// isLiveStripe is the set Stripe calls live: it still bills or still owes.
func isLiveStripe(status string) bool {
	return stripeRank(status) < len(liveRank)
}

// isPaidStripe is the set that carries paid access: active or trialing. Past due
// and unpaid are owed money, not access.
func isPaidStripe(status string) bool {
	return stripeRank(status) < 2
}

// bestStripeSubscription is the subscription the web writes onto a customer's row:
// the best live one, else the newest ended one. Within a rank the newest created
// wins, as in the web. A tie keeps the first seen.
func bestStripeSubscription(subs []webSubscription) (webSubscription, bool) {
	var best webSubscription
	found := false
	for _, s := range subs {
		if !found {
			best, found = s, true
			continue
		}
		rs, rb := stripeRank(s.Status), stripeRank(best.Status)
		if rs < rb || (rs == rb && createdOf(s).After(createdOf(best))) {
			best = s
		}
	}
	return best, found
}

// createdOf reads a Stripe creation time; an unreadable one is the zero time, which
// ranks as oldest.
func createdOf(s webSubscription) time.Time {
	if s.Created == nil {
		return time.Time{}
	}
	t, ok := parseStoreTimestamp(*s.Created)
	if !ok {
		return time.Time{}
	}
	return t
}

// mirrorStatusFor maps a Stripe status to the value the webhook writes. The mapping is
// the web's own: unpaid is recorded as unpaid (Stripe has stopped retrying, so it
// grants nothing, and the banner asks for the card), and an incomplete or paused
// subscription is inactive.
func mirrorStatusFor(stripe string) string {
	s := normaliseRowValue(stripe)
	switch {
	case s == "unpaid":
		return "unpaid"
	case strings.HasPrefix(s, "incomplete"), s == "paused":
		return "inactive"
	}
	return s
}

// parsePeriod reads a period bound as the store returns it.
func parsePeriod(text *string) (time.Time, bool) {
	if text == nil {
		return time.Time{}, false
	}
	return parseStoreTimestamp(*text)
}

// rowForCustomer returns the mirror row that holds a Stripe customer, or nil. The
// schema makes it at most one, because stripe_customer_id is UNIQUE. rows must be
// the whole set, recent rows included: a recent row still holds the customer, and
// skipping it would report the customer as unmirrored.
func rowForCustomer(rows []shortsstore.BillingSubscription, customerID string) *shortsstore.BillingSubscription {
	if customerID == "" {
		return nil
	}
	for i := range rows {
		if rows[i].StripeCustomerID == customerID {
			return &rows[i]
		}
	}
	return nil
}

// billingVerdict is the entitlement the product applies to a row. A grant decides
// first, as it always does. A null status is the one row the product cannot read
// at all (its scan fails), so it grants nothing, and is reported as such.
func billingVerdict(userID string, row *shortsstore.BillingSubscription, now time.Time) Entitlement {
	if row == nil {
		return ResolveEntitlement(userID, nil, now)
	}
	if row.StatusNull {
		if _, granted := InternalTierFor(userID); !granted {
			return Entitlement{Tier: "free", Reason: "null_status", Source: "stripe"}
		}
	}
	return ResolveEntitlement(userID, row.APISubscription(), now)
}

// customerHasLive reports whether Stripe has a live subscription on the customer.
// An empty customer id has none: a row that names no customer cannot be matched.
func customerHasLive(views []stripeCustomerView, customerID string) bool {
	if customerID == "" {
		return false
	}
	for _, v := range views {
		if v.customerID != customerID {
			continue
		}
		for _, s := range v.subs {
			if isLiveStripe(s.Status) {
				return true
			}
		}
	}
	return false
}

// billingDrift compares each Stripe customer with the mirror row that holds it.
// stripeOK is false when Stripe was not fully read: the Stripe-dependent checks
// are then skipped, never guessed. It returns the findings, most severe first, and
// the emails of the rows left out as recent.
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

	// Structure of the mirror itself. These need no Stripe.
	perEmail := map[string]int{}
	for _, r := range eligible {
		perEmail[strings.ToLower(r.UserEmail)]++
	}
	reportedEmail := map[string]bool{}
	for _, r := range eligible {
		if strings.Contains(r.UserID, "@") {
			add(kindEmailKeyedUserID, "the row is keyed by an email address, which no Firebase account can match; the user it belongs to can never be entitled through it")
		}
		if r.StatusNull {
			add(kindNullStatus, "the row has no status; the product cannot read it, so it grants nothing")
		}
		email := strings.ToLower(r.UserEmail)
		if perEmail[email] > 1 && !reportedEmail[email] {
			reportedEmail[email] = true
			add(kindDuplicateEmail, "this email has "+strconv.Itoa(perEmail[email])+" mirror rows")
		}
	}

	flaggedMissingPeriod := map[string]bool{}
	if stripeOK {
		for _, v := range views {
			best, ok := bestStripeSubscription(v.subs)
			if !ok {
				// A customer with no subscription at all has nothing to compare.
				continue
			}
			row := rowForCustomer(rows, v.customerID)
			if row == nil {
				switch {
				case isPaidStripe(best.Status):
					add(kindPaidWithoutMirror, "the customer's "+normaliseRowValue(best.Status)+" subscription is live and no mirror row holds this customer, so it has no paid access")
				case isLiveStripe(best.Status):
					add(kindUnpaidWithoutMirror, "the customer's subscription is "+normaliseRowValue(best.Status)+" and no mirror row holds this customer")
				}
				continue
			}
			if isRecentlyUpdated(*row, now) {
				continue
			}

			ent := billingVerdict(row.UserID, row, now)
			if isPaidStripe(best.Status) && !ent.Entitled {
				add(kindPaidWithoutMirror, "the customer's "+normaliseRowValue(best.Status)+" subscription is live, but the row grants no paid access ("+ent.Reason+")")
			}
			// The payer Stripe recorded at checkout is not the user the row is keyed to:
			// the subscription was stamped onto a stale row, or the account was recreated.
			// The real payer then has no row, and the row's user gets the access.
			if isLiveStripe(best.Status) && best.MetadataUserID != "" && best.MetadataUserID != row.UserID {
				add(kindSubscriptionUserMismatch, subscriptionUserMismatchDetail(best.MetadataUserID, row.UserID))
			}
			if row.StripeSubscriptionID != best.ID {
				if row.StripeSubscriptionID == "" {
					add(kindStaleSubscriptionID, "the row names no subscription; the customer's current one is not recorded on it")
				} else {
					add(kindStaleSubscriptionID, "the row names an earlier subscription, not the customer's current one")
				}
			}
			if !row.StatusNull && normaliseRowValue(row.Status) != mirrorStatusFor(best.Status) {
				add(kindStatusMismatch, "the mirror says "+normaliseRowValue(row.Status)+", Stripe's current subscription says "+normaliseRowValue(best.Status))
			}
			if best.CurrentPeriodEnd != nil {
				stripeEnd, ok := parsePeriod(best.CurrentPeriodEnd)
				if row.CurrentPeriodEnd == nil {
					add(kindMissingPeriodEnd, "Stripe has a current period end ("+periodLabel(stripeEnd, ok)+"); the mirror has none")
					flaggedMissingPeriod[row.UserID] = true
				} else if mirrorEnd, mOK := parsePeriod(row.CurrentPeriodEnd); ok && mOK && mirrorEnd.Sub(stripeEnd).Abs() > billingPeriodTolerance {
					add(kindPeriodEndMismatch, "the mirror ends "+periodLabel(mirrorEnd, true)+", Stripe ends "+periodLabel(stripeEnd, ok))
				}
			}
			if row.CancelAtPeriodEnd != best.CancelAtPeriodEnd {
				add(kindCancelMismatch, "the mirror has cancel at period end set to "+boolLabel(row.CancelAtPeriodEnd)+", Stripe "+boolLabel(best.CancelAtPeriodEnd))
			}
		}

		// A row that grants paid access from Stripe must sit on a customer with a
		// live subscription behind it.
		for _, r := range eligible {
			ent := billingVerdict(r.UserID, &r, now)
			if !ent.Entitled || ent.Source != "stripe" || customerHasLive(views, r.StripeCustomerID) {
				continue
			}
			add(kindEntitledWithoutStripe, "the mirror grants paid access ("+ent.Reason+") but Stripe has no live subscription for this customer")
		}
	}

	// Active with no period end: a mirror-only fact, reported unless the Stripe
	// comparison already said so.
	for _, r := range eligible {
		if normaliseRowValue(r.Status) == "active" && r.CurrentPeriodEnd == nil && !flaggedMissingPeriod[r.UserID] {
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

// subscriptionUserMismatchDetail names both user ids and nothing else. The
// mismatch is a fact about two keys, so it carries no email or name.
func subscriptionUserMismatchDetail(metadataUserID, rowUserID string) string {
	return "Stripe's live subscription for this customer is recorded as belonging to user " +
		strconv.Quote(metadataUserID) + ", but the mirror row for the customer is keyed to user " + strconv.Quote(rowUserID)
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

// exceptionResult is the sweep's findings, most severe first, with the count of
// every kind the sweep checked.
type exceptionResult struct {
	Findings      []mcp.BillingExceptionRow
	Counts        map[string]int
	SkippedRecent int
}

// billingExceptions finds the exceptions across every subscriber. The Stripe side
// is the live list, keyed by customer: each customer's best live subscription is
// set against the one row that holds the customer.
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

	// Every mirror-only kind is always checked, so each is present in counts, zero
	// included. An absent kind means it was not checked.
	for _, kind := range []string{kindPastDue, kindPeriodEnded, kindUnpaidTier, kindMissingPeriodEnd, kindNullStatus, kindEmailKeyedUserID, kindDuplicateEmail} {
		res.Counts[kind] = 0
	}
	if in.AliveOK {
		for _, kind := range []string{kindPaidWithoutMirror, kindSubscriptionUserMismatch, kindUnpaidWithoutMirror, kindStaleSubscriptionID} {
			res.Counts[kind] = 0
		}
		// A cut list cannot show that a customer has no live subscription.
		if !in.AliveTruncated {
			res.Counts[kindEntitledWithoutStripe] = 0
		}
	}

	perEmail := map[string]int{}
	for _, r := range eligible {
		perEmail[strings.ToLower(r.UserEmail)]++
	}
	reportedEmail := map[string]bool{}
	for _, r := range eligible {
		ent := billingVerdict(r.UserID, &r, in.Now)
		if !r.StatusNull && normaliseRowValue(r.Status) == "past_due" {
			add(kindPastDue, r.UserEmail, r.UserID, "payment failed; the row is past_due, and its paid access ends 14 days after the period end")
		}
		if ent.Reason == "period_ended" {
			add(kindPeriodEnded, r.UserEmail, r.UserID, "the row is "+normaliseRowValue(r.Status)+" but its period ended more than the grace allows; Stripe has not renewed it on this row")
		}
		if ent.Reason == "unpaid_tier" {
			add(kindUnpaidTier, r.UserEmail, r.UserID, "the row is "+normaliseRowValue(r.Status)+" on tier "+normaliseRowValue(r.Tier)+", which carries no paid features")
		}
		if r.StatusNull {
			add(kindNullStatus, r.UserEmail, r.UserID, "the row has no status; the product cannot read it, so it grants nothing")
		}
		if !r.StatusNull && normaliseRowValue(r.Status) == "active" && r.CurrentPeriodEnd == nil {
			add(kindMissingPeriodEnd, r.UserEmail, r.UserID, "the row is active with no current period end, so its entitlement cannot be checked against time")
		}
		if strings.Contains(r.UserID, "@") {
			add(kindEmailKeyedUserID, r.UserEmail, r.UserID, "the row is keyed by an email address, which no Firebase account can match")
		}
		email := strings.ToLower(r.UserEmail)
		if perEmail[email] > 1 && !reportedEmail[email] {
			reportedEmail[email] = true
			add(kindDuplicateEmail, r.UserEmail, r.UserID, "this email has "+strconv.Itoa(perEmail[email])+" mirror rows")
		}
	}

	if in.AliveOK {
		for _, b := range bestAliveByCustomer(in.Alive) {
			row := rowForCustomer(in.Rows, b.CustomerID)
			if row == nil {
				if isPaidStripe(b.Status) {
					add(kindPaidWithoutMirror, b.Email, b.MetadataUserID, "Stripe has a "+normaliseRowValue(b.Status)+" subscription and no mirror row holds this customer")
				} else {
					add(kindUnpaidWithoutMirror, b.Email, b.MetadataUserID, "Stripe has a "+normaliseRowValue(b.Status)+" subscription and no mirror row holds this customer")
				}
				continue
			}
			if isRecentlyUpdated(*row, in.Now) {
				continue
			}
			ent := billingVerdict(row.UserID, row, in.Now)
			if isLiveStripe(b.Status) && b.MetadataUserID != "" && b.MetadataUserID != row.UserID {
				add(kindSubscriptionUserMismatch, row.UserEmail, row.UserID, subscriptionUserMismatchDetail(b.MetadataUserID, row.UserID))
			}
			if isPaidStripe(b.Status) && !ent.Entitled {
				add(kindPaidWithoutMirror, row.UserEmail, row.UserID, "Stripe says "+normaliseRowValue(b.Status)+" but the row grants no paid access ("+ent.Reason+")")
			}
			if row.StripeSubscriptionID != b.SubscriptionID {
				add(kindStaleSubscriptionID, row.UserEmail, row.UserID, "the row does not name the customer's current subscription")
			}
		}
	}

	if in.AliveOK && !in.AliveTruncated {
		for _, r := range eligible {
			ent := billingVerdict(r.UserID, &r, in.Now)
			if !ent.Entitled || ent.Source != "stripe" || aliveHasCustomer(in.Alive, r.StripeCustomerID) {
				continue
			}
			add(kindEntitledWithoutStripe, r.UserEmail, r.UserID, "the mirror grants paid access ("+ent.Reason+") but Stripe has no live subscription for this customer")
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

// bestAliveByCustomer picks each customer's best live subscription from the live
// list, by the web's ranking. The list carries no creation time, so a tie of rank
// keeps the first listed. The result is in customer order, so output is stable.
func bestAliveByCustomer(alive []webAliveSubscription) []webAliveSubscription {
	byCustomer := map[string]webAliveSubscription{}
	for _, a := range alive {
		key := a.CustomerID
		if key == "" {
			key = "sub:" + a.SubscriptionID
		}
		cur, ok := byCustomer[key]
		if !ok || stripeRank(a.Status) < stripeRank(cur.Status) {
			byCustomer[key] = a
		}
	}
	keys := make([]string, 0, len(byCustomer))
	for k := range byCustomer {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	out := make([]webAliveSubscription, 0, len(keys))
	for _, k := range keys {
		out = append(out, byCustomer[k])
	}
	return out
}

// aliveHasCustomer reports whether the live list has a subscription on the
// customer. An empty customer id matches nothing.
func aliveHasCustomer(alive []webAliveSubscription, customerID string) bool {
	if customerID == "" {
		return false
	}
	for _, a := range alive {
		if a.CustomerID == customerID {
			return true
		}
	}
	return false
}
