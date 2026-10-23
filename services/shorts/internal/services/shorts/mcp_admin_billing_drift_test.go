package shorts

import (
	"reflect"
	"testing"
	"time"

	"github.com/castlemilk/shorted.com.au/services/shorts/internal/mcp"
	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
)

// The rules below are the audit's whole judgement: each case names the kinds it
// must produce, in severity order, and nothing else.

var billingNow = time.Date(2026, 10, 23, 12, 0, 0, 0, time.UTC)

func billingRFC(t time.Time) *string {
	s := t.UTC().Format(time.RFC3339Nano)
	return &s
}

// billingRow is a mirror row that is entitled and two hours old, unless a
// mod changes it.
func billingRow(now time.Time, uid, email, status string, mods ...func(*shortsstore.BillingSubscription)) shortsstore.BillingSubscription {
	updated := now.Add(-2 * time.Hour)
	created := now.Add(-30 * 24 * time.Hour)
	r := shortsstore.BillingSubscription{
		UserID: uid, UserEmail: email, Status: status, Tier: "premium",
		StripeCustomerID: "cus_" + uid, StripeSubscriptionID: "sub_" + uid,
		CurrentPeriodEnd: billingRFC(now.Add(20 * 24 * time.Hour)),
		CreatedAt:        &created, UpdatedAt: &updated,
	}
	for _, m := range mods {
		m(&r)
	}
	return r
}

func withPeriodEnd(t *time.Time) func(*shortsstore.BillingSubscription) {
	return func(r *shortsstore.BillingSubscription) {
		if t == nil {
			r.CurrentPeriodEnd = nil
			return
		}
		r.CurrentPeriodEnd = billingRFC(*t)
	}
}

func withSubID(id string) func(*shortsstore.BillingSubscription) {
	return func(r *shortsstore.BillingSubscription) { r.StripeSubscriptionID = id }
}

func withCustomer(id string) func(*shortsstore.BillingSubscription) {
	return func(r *shortsstore.BillingSubscription) { r.StripeCustomerID = id }
}

func withRecent(now time.Time, ago time.Duration) func(*shortsstore.BillingSubscription) {
	return func(r *shortsstore.BillingSubscription) {
		u := now.Add(-ago)
		r.UpdatedAt = &u
	}
}

// stripeLive is a live Stripe subscription that matches the default row.
func stripeSub(id, status string, end time.Time) webSubscription {
	return webSubscription{ID: id, Status: status, Tier: "premium", Interval: "month", Amount: 2900, Currency: "aud",
		CurrentPeriodEnd: billingRFC(end), CurrentPeriodStart: billingRFC(end.AddDate(0, -1, 0))}
}

func stripeView(customerID string, subs ...webSubscription) stripeCustomerView {
	return stripeCustomerView{customerID: customerID, lookedUpBy: "customer id", subs: subs}
}

func kindsOf(findings []mcp.BillingDriftFinding) []string {
	out := []string{}
	for _, f := range findings {
		out = append(out, f.Kind)
	}
	return out
}

func TestBillingDriftFindsEachDisagreement(t *testing.T) {
	periodEnd := billingNow.Add(20 * 24 * time.Hour)
	cases := []struct {
		name     string
		rows     []shortsstore.BillingSubscription
		views    []stripeCustomerView
		stripeOK bool
		want     []string
	}{
		{
			name:     "active row, Stripe canceled: the row grants access with no live subscription",
			rows:     []shortsstore.BillingSubscription{billingRow(billingNow, "uid-a", "a@example.com", "active")},
			views:    []stripeCustomerView{stripeView("cus_uid-a", stripeSub("sub_uid-a", "canceled", periodEnd))},
			stripeOK: true,
			want:     []string{kindEntitledWithoutStripe, kindStatusMismatch},
		},
		{
			name:     "Stripe has a period end and the mirror has none",
			rows:     []shortsstore.BillingSubscription{billingRow(billingNow, "uid-a", "a@example.com", "active", withPeriodEnd(nil))},
			views:    []stripeCustomerView{stripeView("cus_uid-a", stripeSub("sub_uid-a", "active", periodEnd))},
			stripeOK: true,
			want:     []string{kindMissingPeriodEnd},
		},
		{
			name:     "a live Stripe subscription with no row is paid without access",
			views:    []stripeCustomerView{stripeView("cus_new", stripeSub("sub_new", "active", periodEnd))},
			stripeOK: true,
			want:     []string{kindPaidWithoutMirror},
		},
		{
			name:     "a canceled Stripe subscription with no row is not a finding",
			views:    []stripeCustomerView{stripeView("cus_old", stripeSub("sub_old", "canceled", periodEnd))},
			stripeOK: true,
			want:     []string{},
		},
		{
			name:     "unpaid is recorded as past_due, so past_due agrees with unpaid",
			rows:     []shortsstore.BillingSubscription{billingRow(billingNow, "uid-a", "a@example.com", "past_due")},
			views:    []stripeCustomerView{stripeView("cus_uid-a", stripeSub("sub_uid-a", "unpaid", periodEnd))},
			stripeOK: true,
			want:     []string{},
		},
		{
			name: "cancel at period end differs",
			rows: []shortsstore.BillingSubscription{billingRow(billingNow, "uid-a", "a@example.com", "active", func(r *shortsstore.BillingSubscription) {
				r.CancelAtPeriodEnd = false
			})},
			views: []stripeCustomerView{stripeView("cus_uid-a", func() webSubscription {
				s := stripeSub("sub_uid-a", "active", periodEnd)
				s.CancelAtPeriodEnd = true
				return s
			}())},
			stripeOK: true,
			want:     []string{kindCancelMismatch},
		},
		{
			name:     "period ends more than an hour apart",
			rows:     []shortsstore.BillingSubscription{billingRow(billingNow, "uid-a", "a@example.com", "active", withPeriodEnd(ptrTime(periodEnd.Add(3*time.Hour))))},
			views:    []stripeCustomerView{stripeView("cus_uid-a", stripeSub("sub_uid-a", "active", periodEnd))},
			stripeOK: true,
			want:     []string{kindPeriodEndMismatch},
		},
		{
			name:     "period ends within the hour are the same",
			rows:     []shortsstore.BillingSubscription{billingRow(billingNow, "uid-a", "a@example.com", "active", withPeriodEnd(ptrTime(periodEnd.Add(30*time.Minute))))},
			views:    []stripeCustomerView{stripeView("cus_uid-a", stripeSub("sub_uid-a", "active", periodEnd))},
			stripeOK: true,
			want:     []string{},
		},
		{
			name:     "a row updated in the last 15 minutes is left out, even when it disagrees",
			rows:     []shortsstore.BillingSubscription{billingRow(billingNow, "uid-a", "a@example.com", "active", withRecent(billingNow, 5*time.Minute))},
			views:    []stripeCustomerView{stripeView("cus_uid-a", stripeSub("sub_uid-a", "canceled", periodEnd))},
			stripeOK: true,
			want:     []string{},
		},
		{
			name: "two rows for one email are a finding on each",
			rows: []shortsstore.BillingSubscription{
				billingRow(billingNow, "uid-a", "dup@example.com", "canceled"),
				billingRow(billingNow, "uid-b", "dup@example.com", "canceled"),
			},
			stripeOK: false,
			want:     []string{kindDuplicateEmail, kindDuplicateEmail},
		},
		{
			name:     "a row keyed by an email address",
			rows:     []shortsstore.BillingSubscription{billingRow(billingNow, "legacy@example.com", "legacy@example.com", "canceled")},
			stripeOK: false,
			want:     []string{kindEmailKeyedUserID},
		},
		{
			name:     "the row's own customer has a live subscription under a new id",
			rows:     []shortsstore.BillingSubscription{billingRow(billingNow, "uid-a", "a@example.com", "active", withSubID(""), withPeriodEnd(&periodEnd))},
			views:    []stripeCustomerView{stripeView("cus_uid-a", stripeSub("sub_new", "active", periodEnd))},
			stripeOK: true,
			want:     []string{},
		},
		{
			name:     "an operator grant is not entitled from Stripe, so it is not flagged",
			rows:     []shortsstore.BillingSubscription{billingRow(billingNow, "uid-granted", "g@example.com", "canceled")},
			stripeOK: true,
			want:     []string{},
		},
		{
			name:     "Stripe unread: no Stripe finding, but the mirror-only checks still run",
			rows:     []shortsstore.BillingSubscription{billingRow(billingNow, "uid-a", "a@example.com", "active", withPeriodEnd(nil))},
			stripeOK: false,
			want:     []string{kindMissingPeriodEnd},
		},
		{
			name:     "Stripe unread: a live Stripe subscription is not reported as paid without mirror",
			views:    []stripeCustomerView{stripeView("cus_new", stripeSub("sub_new", "active", periodEnd))},
			stripeOK: false,
			want:     []string{},
		},
		{
			name:     "active with no period end and no live Stripe subscription",
			rows:     []shortsstore.BillingSubscription{billingRow(billingNow, "uid-a", "a@example.com", "active", withPeriodEnd(nil))},
			stripeOK: true,
			views:    nil,
			want:     []string{kindEntitledWithoutStripe, kindMissingPeriodEnd},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if tc.name == "an operator grant is not entitled from Stripe, so it is not flagged" {
				t.Setenv(InternalTierUsersEnv, "uid-granted")
			}
			findings, _ := billingDrift(billingNow, tc.rows, tc.views, tc.stripeOK)
			got := kindsOf(findings)
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("kinds = %v, want %v; findings %+v", got, tc.want, findings)
			}
		})
	}
}

// Recent rows are reported by email, so the note can say which were skipped.
func TestBillingDriftNamesTheRowsItSkipped(t *testing.T) {
	rows := []shortsstore.BillingSubscription{billingRow(billingNow, "uid-a", "fresh@example.com", "active", withRecent(billingNow, time.Minute))}
	findings, skipped := billingDrift(billingNow, rows, nil, true)
	if len(findings) != 0 || !reflect.DeepEqual(skipped, []string{"fresh@example.com"}) {
		t.Fatalf("findings %+v, skipped %v", findings, skipped)
	}
}

func TestMirrorStatusMapsTheWebhooksOwnVocabulary(t *testing.T) {
	for stripe, want := range map[string]string{
		"active": "active", "trialing": "trialing", "past_due": "past_due", "canceled": "canceled",
		"unpaid": "past_due", "incomplete": "inactive", "incomplete_expired": "inactive", "paused": "inactive",
	} {
		if got := mirrorStatusFor(stripe); got != want {
			t.Errorf("mirrorStatusFor(%s) = %s, want %s", stripe, got, want)
		}
	}
}

func TestBillingExceptionsSweepsEveryKindOnce(t *testing.T) {
	now := billingNow
	// The grace is the product's own (periodEndGrace), so the fixtures sit either
	// side of it rather than at a copied number.
	periodEnded := now.Add(-(periodEndGrace + 24*time.Hour))
	withinGrace := now.Add(-periodEndGrace / 2)
	// liveWith is the live Stripe list for the rows, each at the given status.
	liveWith := func(status string, rows ...shortsstore.BillingSubscription) []webAliveSubscription {
		var out []webAliveSubscription
		for _, r := range rows {
			out = append(out, webAliveSubscription{CustomerID: r.StripeCustomerID, SubscriptionID: r.StripeSubscriptionID, Status: status, Tier: "premium", Email: r.UserEmail, MetadataUserID: r.UserID})
		}
		return out
	}
	cases := []struct {
		name    string
		rows    []shortsstore.BillingSubscription
		alive   []webAliveSubscription
		aliveOK bool
		trunc   bool
		want    map[string]int
		rowsOf  []string // kinds in severity order
	}{
		{
			name:    "past due",
			rows:    []shortsstore.BillingSubscription{billingRow(billingNow, "uid-a", "a@example.com", "past_due")},
			alive:   liveWith("past_due", billingRow(billingNow, "uid-a", "a@example.com", "past_due")),
			aliveOK: true,
			rowsOf:  []string{kindPastDue},
		},
		{
			name:    "period ended beyond the grace",
			rows:    []shortsstore.BillingSubscription{billingRow(billingNow, "uid-a", "a@example.com", "active", withPeriodEnd(&periodEnded))},
			aliveOK: true,
			rowsOf:  []string{kindPeriodEnded},
		},
		{
			name:    "period ended within the grace is still entitled, so no period finding",
			rows:    []shortsstore.BillingSubscription{billingRow(billingNow, "uid-a", "a@example.com", "active", withPeriodEnd(&withinGrace))},
			alive:   liveWith("active", billingRow(billingNow, "uid-a", "a@example.com", "active")),
			aliveOK: true,
			rowsOf:  []string{},
		},
		{
			name:    "active on an unpaid tier",
			rows:    []shortsstore.BillingSubscription{billingRow(billingNow, "uid-a", "a@example.com", "active", func(r *shortsstore.BillingSubscription) { r.Tier = "free" })},
			aliveOK: true,
			rowsOf:  []string{kindUnpaidTier},
		},
		{
			name:    "active with no period end",
			rows:    []shortsstore.BillingSubscription{billingRow(billingNow, "uid-a", "a@example.com", "active", withPeriodEnd(nil))},
			alive:   liveWith("active", billingRow(billingNow, "uid-a", "a@example.com", "active")),
			aliveOK: true,
			rowsOf:  []string{kindMissingPeriodEnd},
		},
		{
			name:    "email as user id",
			rows:    []shortsstore.BillingSubscription{billingRow(billingNow, "a@example.com", "a@example.com", "canceled")},
			aliveOK: true,
			rowsOf:  []string{kindEmailKeyedUserID},
		},
		{
			name: "two rows for one email",
			rows: []shortsstore.BillingSubscription{
				billingRow(billingNow, "uid-a", "dup@example.com", "canceled"),
				billingRow(billingNow, "uid-b", "dup@example.com", "canceled"),
			},
			aliveOK: true,
			rowsOf:  []string{kindDuplicateEmail, kindDuplicateEmail},
		},
		{
			name:    "a paid row with no live Stripe subscription",
			rows:    []shortsstore.BillingSubscription{billingRow(billingNow, "uid-a", "a@example.com", "active")},
			aliveOK: true,
			rowsOf:  []string{kindEntitledWithoutStripe},
		},
		{
			name:    "a live Stripe subscription with no row",
			alive:   []webAliveSubscription{{CustomerID: "cus_ghost", SubscriptionID: "sub_ghost", Status: "active", Email: "ghost@example.com", MetadataUserID: "uid-ghost"}},
			aliveOK: true,
			rowsOf:  []string{kindPaidWithoutMirror},
		},
		{
			name:    "live Stripe active, row canceled: paid without access",
			rows:    []shortsstore.BillingSubscription{billingRow(billingNow, "uid-c", "c@example.com", "canceled", withSubID(""), withCustomer(""))},
			alive:   []webAliveSubscription{{CustomerID: "cus_c", SubscriptionID: "sub_c", Status: "active", Email: "c@example.com", MetadataUserID: "uid-c"}},
			aliveOK: true,
			rowsOf:  []string{kindPaidWithoutMirror},
		},
		{
			name:    "live Stripe past_due, row canceled: money not taken, so not paid without access",
			rows:    []shortsstore.BillingSubscription{billingRow(billingNow, "uid-c", "c@example.com", "canceled", withSubID(""), withCustomer(""))},
			alive:   []webAliveSubscription{{CustomerID: "cus_c", SubscriptionID: "sub_c", Status: "past_due", Email: "c@example.com", MetadataUserID: "uid-c"}},
			aliveOK: true,
			rowsOf:  []string{},
		},
		{
			name:    "a live Stripe subscription without a user id is matched by email",
			rows:    []shortsstore.BillingSubscription{billingRow(billingNow, "uid-e", "e@example.com", "canceled", withSubID(""), withCustomer(""))},
			alive:   []webAliveSubscription{{CustomerID: "cus_e", SubscriptionID: "sub_e", Status: "active", Email: "E@example.com"}},
			aliveOK: true,
			rowsOf:  []string{kindPaidWithoutMirror},
		},
		{
			name:    "a cut live list does not run entitled_without_stripe",
			rows:    []shortsstore.BillingSubscription{billingRow(billingNow, "uid-a", "a@example.com", "active")},
			aliveOK: true,
			trunc:   true,
			rowsOf:  []string{},
		},
		{
			name:    "a recent row is skipped and not reported",
			rows:    []shortsstore.BillingSubscription{billingRow(billingNow, "uid-a", "a@example.com", "past_due", withRecent(billingNow, 3*time.Minute))},
			aliveOK: true,
			rowsOf:  []string{},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			res := billingExceptions(exceptionInput{Now: now, Rows: tc.rows, Alive: tc.alive, AliveOK: tc.aliveOK, AliveTruncated: tc.trunc})
			var got []string
			for _, f := range res.Findings {
				got = append(got, f.Kind)
			}
			if got == nil {
				got = []string{}
			}
			if !reflect.DeepEqual(got, tc.rowsOf) {
				t.Fatalf("kinds = %v, want %v; findings %+v", got, tc.rowsOf, res.Findings)
			}
		})
	}
}

// Counts name every kind the sweep checked, zero included, so an absent kind
// means "not checked". A cut live list leaves entitled_without_stripe out.
func TestBillingExceptionsCountsNameWhatWasChecked(t *testing.T) {
	rows := []shortsstore.BillingSubscription{billingRow(billingNow, "uid-a", "a@example.com", "past_due")}
	full := billingExceptions(exceptionInput{Now: billingNow, Rows: rows, AliveOK: true})
	if full.Counts[kindPastDue] != 1 || full.Counts[kindUnpaidTier] != 0 || full.Counts[kindEntitledWithoutStripe] != 0 || full.Counts[kindPaidWithoutMirror] != 0 {
		t.Fatalf("counts = %v, want every checked kind present, zero included", full.Counts)
	}
	cut := billingExceptions(exceptionInput{Now: billingNow, Rows: rows, AliveOK: true, AliveTruncated: true})
	if _, ok := cut.Counts[kindEntitledWithoutStripe]; ok {
		t.Fatalf("a cut live list counted entitled_without_stripe: %v", cut.Counts)
	}
	unread := billingExceptions(exceptionInput{Now: billingNow, Rows: rows})
	if _, ok := unread.Counts[kindPaidWithoutMirror]; ok {
		t.Fatalf("an unread live list counted paid_without_mirror: %v", unread.Counts)
	}
	if _, ok := unread.Counts[kindPastDue]; !ok {
		t.Fatalf("mirror-only kinds must still be counted: %v", unread.Counts)
	}
}

// Severity order is the rule: money taken with no access before access with
// no money, and both before the mirror's own tidy-ups.
func TestBillingExceptionsOrdersBySeverity(t *testing.T) {
	rows := []shortsstore.BillingSubscription{
		billingRow(billingNow, "uid-b", "b@example.com", "past_due"),
		billingRow(billingNow, "uid-z", "z@example.com", "active", withPeriodEnd(nil)),
		billingRow(billingNow, "uid-c", "c@example.com", "canceled", withSubID(""), withCustomer("")),
	}
	alive := []webAliveSubscription{{CustomerID: "cus_c", SubscriptionID: "sub_c", Status: "active", Email: "c@example.com", MetadataUserID: "uid-c"}}
	res := billingExceptions(exceptionInput{Now: billingNow, Rows: rows, Alive: alive, AliveOK: true})
	var got []string
	for _, f := range res.Findings {
		got = append(got, f.Kind)
	}
	want := []string{kindPaidWithoutMirror, kindEntitledWithoutStripe, kindPastDue, kindMissingPeriodEnd}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("order = %v, want %v", got, want)
	}
}

func ptrTime(t time.Time) *time.Time { return &t }
