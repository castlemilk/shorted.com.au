package shorts

import (
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/castlemilk/shorted.com.au/services/shorts/internal/mcp"
	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
)

// The rules below are the audit's whole judgement. Each case names the kinds it
// must produce, in severity order, and nothing else. The comparison is by
// CUSTOMER: a row is set against the customer's best subscription, chosen by the
// web's ranking, and found by its customer id.

var billingNow = time.Date(2026, 10, 23, 12, 0, 0, 0, time.UTC)

func billingRFC(t time.Time) *string {
	s := t.UTC().Format(time.RFC3339Nano)
	return &s
}

// billingRow is a mirror row for uid, on customer cus_<uid> and subscription
// sub_<uid>: entitled, premium, two hours old, a period that runs twenty days on.
// The mods change it.
func billingRow(now time.Time, uid, email, status string, mods ...func(*shortsstore.BillingSubscription)) shortsstore.BillingSubscription {
	updated := now.Add(-2 * time.Hour)
	created := now.Add(-30 * 24 * time.Hour)
	r := shortsstore.BillingSubscription{
		UserID: uid, UserEmail: email, Status: status, Tier: "premium",
		StripeCustomerID: "cus_" + uid, StripeSubscriptionID: "sub_" + uid,
		CurrentPeriodEnd: billingRFC(now.Add(20 * 24 * time.Hour)),
		CreatedAt:        &created, UpdatedAt: &updated,
	}
	// A past_due row is one whose 14-day grace is over: the drift cases were written
	// against past_due granting nothing. A grace-period row is built with a mod.
	if status == "past_due" {
		r.CurrentPeriodEnd = billingRFC(now.Add(-20 * 24 * time.Hour))
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

func withTier(tier string) func(*shortsstore.BillingSubscription) {
	return func(r *shortsstore.BillingSubscription) { r.Tier = tier }
}

func withCancel(cancel bool) func(*shortsstore.BillingSubscription) {
	return func(r *shortsstore.BillingSubscription) { r.CancelAtPeriodEnd = cancel }
}

func withNullStatus() func(*shortsstore.BillingSubscription) {
	return func(r *shortsstore.BillingSubscription) { r.Status, r.StatusNull = "", true }
}

func withRecent(now time.Time, ago time.Duration) func(*shortsstore.BillingSubscription) {
	return func(r *shortsstore.BillingSubscription) {
		u := now.Add(-ago)
		r.UpdatedAt = &u
	}
}

// stripeSub is one Stripe subscription with the given id, status and period end,
// created a day before billingNow unless the test overrides it.
func stripeSub(id, status string, end time.Time) webSubscription {
	created := billingNow.Add(-24 * time.Hour)
	return webSubscription{ID: id, Status: status, Tier: "premium", Interval: "month", Amount: new(int64(2900)), Currency: "aud",
		CurrentPeriodEnd: billingRFC(end), CurrentPeriodStart: billingRFC(end.AddDate(0, -1, 0)), Created: billingRFC(created)}
}

func stripeSubCreated(id, status string, end, created time.Time) webSubscription {
	s := stripeSub(id, status, end)
	s.Created = billingRFC(created)
	return s
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
			name:     "matching row and best subscription: no drift",
			rows:     []shortsstore.BillingSubscription{billingRow(billingNow, "uid-a", "a@example.com", "active")},
			views:    []stripeCustomerView{stripeView("cus_uid-a", stripeSub("sub_uid-a", "active", periodEnd))},
			stripeOK: true,
			want:     []string{},
		},
		{
			// The customer's newest live subscription is sub_new; the row still names
			// the one that created it. Its state is right, so the id alone is low severity.
			name: "the row names an older subscription than the customer's best",
			rows: []shortsstore.BillingSubscription{billingRow(billingNow, "uid-a", "a@example.com", "active", withSubID("sub_old"))},
			views: []stripeCustomerView{stripeView("cus_uid-a",
				stripeSubCreated("sub_old", "canceled", periodEnd, billingNow.Add(-60*24*time.Hour)),
				stripeSubCreated("sub_new", "active", periodEnd, billingNow.Add(-24*time.Hour)))},
			stripeOK: true,
			want:     []string{kindStaleSubscriptionID},
		},
		{
			name:     "a row that names no subscription is stale too",
			rows:     []shortsstore.BillingSubscription{billingRow(billingNow, "uid-a", "a@example.com", "active", withSubID(""))},
			views:    []stripeCustomerView{stripeView("cus_uid-a", stripeSub("sub_uid-a", "active", periodEnd))},
			stripeOK: true,
			want:     []string{kindStaleSubscriptionID},
		},
		{
			name:     "a live subscription with no row holding its customer is paid without mirror",
			views:    []stripeCustomerView{stripeView("cus_new", stripeSub("sub_new", "active", periodEnd))},
			stripeOK: true,
			want:     []string{kindPaidWithoutMirror},
		},
		{
			name:     "a trialing subscription with no row is paid without mirror",
			views:    []stripeCustomerView{stripeView("cus_new", stripeSub("sub_new", "trialing", periodEnd))},
			stripeOK: true,
			want:     []string{kindPaidWithoutMirror},
		},
		{
			// past_due and unpaid are owed money, not access: a different, lower finding.
			name:     "a past-due subscription with no row is unpaid without mirror, not paid",
			views:    []stripeCustomerView{stripeView("cus_new", stripeSub("sub_new", "past_due", periodEnd))},
			stripeOK: true,
			want:     []string{kindUnpaidWithoutMirror},
		},
		{
			name:     "an unpaid subscription with no row is unpaid without mirror",
			views:    []stripeCustomerView{stripeView("cus_new", stripeSub("sub_new", "unpaid", periodEnd))},
			stripeOK: true,
			want:     []string{kindUnpaidWithoutMirror},
		},
		{
			name:     "an ended subscription with no row is not a finding",
			views:    []stripeCustomerView{stripeView("cus_old", stripeSub("sub_old", "canceled", periodEnd))},
			stripeOK: true,
			want:     []string{},
		},
		{
			// The customer has a live subscription under a new id, and its row holds the
			// customer. The row must not read as unmirrored just because its id is old.
			name:     "a customer with a row is not paid without mirror when only its id is stale",
			rows:     []shortsstore.BillingSubscription{billingRow(billingNow, "uid-a", "a@example.com", "active", withSubID("sub_gone"))},
			views:    []stripeCustomerView{stripeView("cus_uid-a", stripeSub("sub_new", "active", periodEnd))},
			stripeOK: true,
			want:     []string{kindStaleSubscriptionID},
		},
		{
			// The best live subscription says the customer should have access, and the row
			// grants none. Money taken with no access, and the row's status is wrong too.
			name:     "a live subscription on a row that grants nothing is paid without mirror",
			rows:     []shortsstore.BillingSubscription{billingRow(billingNow, "uid-c", "c@example.com", "canceled")},
			views:    []stripeCustomerView{stripeView("cus_uid-c", stripeSub("sub_uid-c", "active", periodEnd))},
			stripeOK: true,
			want:     []string{kindPaidWithoutMirror, kindStatusMismatch},
		},
		{
			name:     "the same live subscription on a row that is entitled reads nothing of the sort",
			rows:     []shortsstore.BillingSubscription{billingRow(billingNow, "uid-c", "c@example.com", "active")},
			views:    []stripeCustomerView{stripeView("cus_uid-c", stripeSub("sub_uid-c", "active", periodEnd))},
			stripeOK: true,
			want:     []string{},
		},
		{
			// Stripe's best is past due; the row is still entitled on its own status.
			name:     "a row active while the customer's best is past due disagrees on status",
			rows:     []shortsstore.BillingSubscription{billingRow(billingNow, "uid-a", "a@example.com", "active")},
			views:    []stripeCustomerView{stripeView("cus_uid-a", stripeSub("sub_uid-a", "past_due", periodEnd))},
			stripeOK: true,
			want:     []string{kindStatusMismatch},
		},
		{
			name:     "unpaid is recorded as inactive, so inactive agrees with unpaid",
			rows:     []shortsstore.BillingSubscription{billingRow(billingNow, "uid-a", "a@example.com", "inactive")},
			views:    []stripeCustomerView{stripeView("cus_uid-a", stripeSub("sub_uid-a", "unpaid", periodEnd))},
			stripeOK: true,
			want:     []string{},
		},
		{
			name: "cancel at period end differs",
			rows: []shortsstore.BillingSubscription{billingRow(billingNow, "uid-a", "a@example.com", "active", withCancel(false))},
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
			rows:     []shortsstore.BillingSubscription{billingRow(billingNow, "uid-a", "a@example.com", "active", withPeriodEnd(new(periodEnd.Add(3*time.Hour))))},
			views:    []stripeCustomerView{stripeView("cus_uid-a", stripeSub("sub_uid-a", "active", periodEnd))},
			stripeOK: true,
			want:     []string{kindPeriodEndMismatch},
		},
		{
			name:     "period ends within the hour are the same",
			rows:     []shortsstore.BillingSubscription{billingRow(billingNow, "uid-a", "a@example.com", "active", withPeriodEnd(new(periodEnd.Add(30*time.Minute))))},
			views:    []stripeCustomerView{stripeView("cus_uid-a", stripeSub("sub_uid-a", "active", periodEnd))},
			stripeOK: true,
			want:     []string{},
		},
		{
			name:     "Stripe has a period end and the mirror has none",
			rows:     []shortsstore.BillingSubscription{billingRow(billingNow, "uid-a", "a@example.com", "active", withPeriodEnd(nil))},
			views:    []stripeCustomerView{stripeView("cus_uid-a", stripeSub("sub_uid-a", "active", periodEnd))},
			stripeOK: true,
			want:     []string{kindMissingPeriodEnd},
		},
		{
			// A row updated in the last 15 minutes is left out, even though it disagrees.
			name:     "a row updated in the last 15 minutes is left out of drift",
			rows:     []shortsstore.BillingSubscription{billingRow(billingNow, "uid-a", "a@example.com", "active", withRecent(billingNow, 5*time.Minute))},
			views:    []stripeCustomerView{stripeView("cus_uid-a", stripeSub("sub_uid-a", "canceled", periodEnd))},
			stripeOK: true,
			want:     []string{},
		},
		{
			// The recent row still holds the customer, so the live subscription is not
			// unmirrored: the row is simply not compared yet.
			name:     "a recent row still counts as holding its customer",
			rows:     []shortsstore.BillingSubscription{billingRow(billingNow, "uid-c", "c@example.com", "canceled", withRecent(billingNow, 3*time.Minute))},
			views:    []stripeCustomerView{stripeView("cus_uid-c", stripeSub("sub_uid-c", "active", periodEnd))},
			stripeOK: true,
			want:     []string{},
		},
		{
			// An entitled row on a customer Stripe has no live subscription for.
			name:     "an entitled row whose customer has no live subscription",
			rows:     []shortsstore.BillingSubscription{billingRow(billingNow, "uid-a", "a@example.com", "active")},
			views:    []stripeCustomerView{stripeView("cus_uid-a", stripeSub("sub_uid-a", "canceled", periodEnd))},
			stripeOK: true,
			want:     []string{kindEntitledWithoutStripe, kindStatusMismatch},
		},
		{
			name:     "an entitled row whose customer Stripe does not know",
			rows:     []shortsstore.BillingSubscription{billingRow(billingNow, "uid-a", "a@example.com", "active")},
			stripeOK: true,
			want:     []string{kindEntitledWithoutStripe},
		},
		{
			name: "two rows for one email are one duplicate finding",
			rows: []shortsstore.BillingSubscription{
				billingRow(billingNow, "uid-a", "dup@example.com", "canceled"),
				billingRow(billingNow, "uid-b", "dup@example.com", "canceled"),
			},
			stripeOK: false,
			want:     []string{kindDuplicateEmail},
		},
		{
			name:     "a row keyed by an email address",
			rows:     []shortsstore.BillingSubscription{billingRow(billingNow, "legacy@example.com", "legacy@example.com", "canceled")},
			stripeOK: false,
			want:     []string{kindEmailKeyedUserID},
		},
		{
			name:     "a row with no status is a finding, and Stripe's view of it is not guessed",
			rows:     []shortsstore.BillingSubscription{billingRow(billingNow, "uid-a", "a@example.com", "", withNullStatus())},
			views:    []stripeCustomerView{stripeView("cus_uid-a", stripeSub("sub_uid-a", "canceled", periodEnd))},
			stripeOK: true,
			want:     []string{kindNullStatus},
		},
		{
			// The customer's best is live, and the row with no status grants nothing.
			name:     "a null-status row on a live customer grants nothing",
			rows:     []shortsstore.BillingSubscription{billingRow(billingNow, "uid-a", "a@example.com", "", withNullStatus())},
			views:    []stripeCustomerView{stripeView("cus_uid-a", stripeSub("sub_uid-a", "active", periodEnd))},
			stripeOK: true,
			want:     []string{kindPaidWithoutMirror, kindNullStatus},
		},
		{
			name:     "an operator grant on an unpaid tier is not entitlement, so the live customer is paid without mirror",
			rows:     []shortsstore.BillingSubscription{billingRow(billingNow, "uid-granted", "g@example.com", "active")},
			views:    []stripeCustomerView{stripeView("cus_uid-granted", stripeSub("sub_uid-granted", "active", periodEnd))},
			stripeOK: true,
			want:     []string{kindPaidWithoutMirror},
		},
		{
			name:     "Stripe unread: no Stripe finding, but the mirror-only checks still run",
			rows:     []shortsstore.BillingSubscription{billingRow(billingNow, "uid-a", "a@example.com", "active", withPeriodEnd(nil))},
			stripeOK: false,
			want:     []string{kindMissingPeriodEnd},
		},
		{
			name:     "Stripe unread: a live Stripe customer is not reported as paid without mirror",
			views:    []stripeCustomerView{stripeView("cus_new", stripeSub("sub_new", "active", periodEnd))},
			stripeOK: false,
			want:     []string{},
		},
		{
			name:     "active with no period end and no Stripe customer",
			rows:     []shortsstore.BillingSubscription{billingRow(billingNow, "uid-a", "a@example.com", "active", withPeriodEnd(nil))},
			stripeOK: true,
			want:     []string{kindEntitledWithoutStripe, kindMissingPeriodEnd},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if tc.name == "an operator grant on an unpaid tier is not entitlement, so the live customer is paid without mirror" {
				t.Setenv(InternalTierUsersEnv, "uid-granted")
				t.Setenv(InternalTierEnv, "free")
			}
			findings, _ := billingDrift(billingNow, tc.rows, tc.views, tc.stripeOK)
			got := kindsOf(findings)
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("kinds = %v, want %v; findings %+v", got, tc.want, findings)
			}
		})
	}
}

// Stripe's ranking is the web's: live beats ended, then active, trialing,
// past_due, unpaid, then the newest ended one.
func TestBestStripeSubscriptionFollowsTheWebRanking(t *testing.T) {
	end := billingNow.Add(20 * 24 * time.Hour)
	old := billingNow.Add(-60 * 24 * time.Hour)
	mid := billingNow.Add(-30 * 24 * time.Hour)
	newest := billingNow.Add(-1 * 24 * time.Hour)
	cases := []struct {
		name string
		subs []webSubscription
		want string
	}{
		{"active beats trialing whatever the order", []webSubscription{stripeSubCreated("t", "trialing", end, newest), stripeSubCreated("a", "active", end, old)}, "a"},
		{"trialing beats past_due", []webSubscription{stripeSubCreated("p", "past_due", end, newest), stripeSubCreated("t", "trialing", end, old)}, "t"},
		{"past_due beats unpaid", []webSubscription{stripeSubCreated("u", "unpaid", end, newest), stripeSubCreated("p", "past_due", end, old)}, "p"},
		{"unpaid beats every ended status", []webSubscription{stripeSubCreated("c", "canceled", end, newest), stripeSubCreated("u", "unpaid", end, old)}, "u"},
		{"within a rank the newest created wins", []webSubscription{stripeSubCreated("old", "active", end, old), stripeSubCreated("new", "active", end, newest)}, "new"},
		{"an ended customer's best is its newest ended one", []webSubscription{stripeSubCreated("old", "canceled", end, old), stripeSubCreated("new", "incomplete", end, newest), stripeSubCreated("mid", "canceled", end, mid)}, "new"},
		{"a status not listed ranks as ended", []webSubscription{stripeSubCreated("weird", "something_else", end, newest), stripeSubCreated("u", "unpaid", end, old)}, "u"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			best, ok := bestStripeSubscription(tc.subs)
			if !ok || best.ID != tc.want {
				t.Fatalf("best = %q (ok %v), want %q", best.ID, ok, tc.want)
			}
		})
	}
	if _, ok := bestStripeSubscription(nil); ok {
		t.Fatal("a customer with no subscriptions has no best")
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
		"unpaid": "inactive", "incomplete": "inactive", "incomplete_expired": "inactive", "paused": "inactive",
	} {
		if got := mirrorStatusFor(stripe); got != want {
			t.Errorf("mirrorStatusFor(%s) = %s, want %s", stripe, got, want)
		}
	}
}

func TestBillingExceptionsSweepsEveryKindOnce(t *testing.T) {
	now := billingNow
	endedBeyondGrace := now.Add(-(periodEndGrace + 24*time.Hour))
	withinGrace := now.Add(-periodEndGrace / 2)
	live := func(status string, rows ...shortsstore.BillingSubscription) []webAliveSubscription {
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
		rowsOf  []string // kinds in severity order
	}{
		{
			name:    "past due",
			rows:    []shortsstore.BillingSubscription{billingRow(now, "uid-a", "a@example.com", "past_due")},
			alive:   live("past_due", billingRow(now, "uid-a", "a@example.com", "past_due")),
			aliveOK: true,
			rowsOf:  []string{kindPastDue},
		},
		{
			name:   "period ended beyond the grace",
			rows:   []shortsstore.BillingSubscription{billingRow(now, "uid-a", "a@example.com", "active", withPeriodEnd(&endedBeyondGrace))},
			rowsOf: []string{kindPeriodEnded},
		},
		{
			name:   "period ended within the grace is still entitled, so no period finding",
			rows:   []shortsstore.BillingSubscription{billingRow(now, "uid-a", "a@example.com", "active", withPeriodEnd(&withinGrace))},
			rowsOf: []string{},
		},
		{
			name:   "active on an unpaid tier",
			rows:   []shortsstore.BillingSubscription{billingRow(now, "uid-a", "a@example.com", "active", withTier("free"))},
			rowsOf: []string{kindUnpaidTier},
		},
		{
			name:   "active with no period end",
			rows:   []shortsstore.BillingSubscription{billingRow(now, "uid-a", "a@example.com", "active", withPeriodEnd(nil))},
			rowsOf: []string{kindMissingPeriodEnd},
		},
		{
			name:   "email as user id",
			rows:   []shortsstore.BillingSubscription{billingRow(now, "a@example.com", "a@example.com", "canceled")},
			rowsOf: []string{kindEmailKeyedUserID},
		},
		{
			name:   "a row with no status",
			rows:   []shortsstore.BillingSubscription{billingRow(now, "uid-a", "a@example.com", "", withNullStatus())},
			rowsOf: []string{kindNullStatus},
		},
		{
			name: "two rows for one email are one duplicate finding",
			rows: []shortsstore.BillingSubscription{
				billingRow(now, "uid-a", "dup@example.com", "canceled"),
				billingRow(now, "uid-b", "dup@example.com", "canceled"),
			},
			rowsOf: []string{kindDuplicateEmail},
		},
		{
			name:    "a paid row with no live Stripe subscription",
			rows:    []shortsstore.BillingSubscription{billingRow(now, "uid-a", "a@example.com", "active")},
			aliveOK: true,
			rowsOf:  []string{kindEntitledWithoutStripe},
		},
		{
			name:    "a live Stripe customer with no row",
			alive:   []webAliveSubscription{{CustomerID: "cus_ghost", SubscriptionID: "sub_ghost", Status: "active", Email: "ghost@example.com", MetadataUserID: "uid-ghost"}},
			aliveOK: true,
			rowsOf:  []string{kindPaidWithoutMirror},
		},
		{
			name:    "a past-due customer with no row is owed money, not paid",
			alive:   []webAliveSubscription{{CustomerID: "cus_owed", SubscriptionID: "sub_owed", Status: "past_due", Email: "owed@example.com"}},
			aliveOK: true,
			rowsOf:  []string{kindUnpaidWithoutMirror},
		},
		{
			// The row holds the customer, under its own id and email, and grants nothing
			// while Stripe says active.
			name:    "a live customer's row grants nothing",
			rows:    []shortsstore.BillingSubscription{billingRow(now, "uid-c", "c@example.com", "canceled", withSubID(""), withCustomer("cus_c"))},
			alive:   []webAliveSubscription{{CustomerID: "cus_c", SubscriptionID: "sub_c", Status: "active", Email: "c@example.com", MetadataUserID: "uid-c"}},
			aliveOK: true,
			rowsOf:  []string{kindPaidWithoutMirror, kindStaleSubscriptionID},
		},
		{
			name:    "live Stripe past_due, row canceled: money not taken, so not paid without access",
			rows:    []shortsstore.BillingSubscription{billingRow(now, "uid-c", "c@example.com", "canceled", withCustomer("cus_c"))},
			alive:   []webAliveSubscription{{CustomerID: "cus_c", SubscriptionID: "sub_c", Status: "past_due", Email: "c@example.com"}},
			aliveOK: true,
			rowsOf:  []string{kindStaleSubscriptionID},
		},
		{
			// A row found by its customer id is the match, even when its email differs
			// from the Stripe one: the customer is what holds it.
			name:    "a row under another email still holds its customer",
			rows:    []shortsstore.BillingSubscription{billingRow(now, "uid-e", "e-other@example.com", "active", withCustomer("cus_e"), withSubID("sub_e"))},
			alive:   []webAliveSubscription{{CustomerID: "cus_e", SubscriptionID: "sub_e", Status: "active", Email: "E@example.com"}},
			aliveOK: true,
			rowsOf:  []string{},
		},
		{
			name:    "a row that names an earlier subscription than the customer's live one is stale",
			rows:    []shortsstore.BillingSubscription{billingRow(now, "uid-e", "e@example.com", "active", withCustomer("cus_e"), withSubID("sub_old"))},
			alive:   []webAliveSubscription{{CustomerID: "cus_e", SubscriptionID: "sub_new", Status: "active", Email: "e@example.com"}},
			aliveOK: true,
			rowsOf:  []string{kindStaleSubscriptionID},
		},
		{
			name:    "a paid row with no live Stripe subscription, while the live list is cut",
			rows:    []shortsstore.BillingSubscription{billingRow(now, "uid-a", "a@example.com", "active")},
			aliveOK: true,
			trunc:   true,
			rowsOf:  []string{},
		},
		{
			name:    "a recent row is skipped and not reported, even when Stripe disagrees",
			rows:    []shortsstore.BillingSubscription{billingRow(now, "uid-c", "c@example.com", "canceled", withCustomer("cus_c"), withRecent(now, 3*time.Minute))},
			alive:   []webAliveSubscription{{CustomerID: "cus_c", SubscriptionID: "sub_c", Status: "active", Email: "c@example.com"}},
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
	for _, kind := range []string{kindPaidWithoutMirror, kindUnpaidWithoutMirror, kindStaleSubscriptionID} {
		if _, ok := unread.Counts[kind]; ok {
			t.Fatalf("an unread live list counted %s: %v", kind, unread.Counts)
		}
	}
	if _, ok := unread.Counts[kindPastDue]; !ok {
		t.Fatalf("mirror-only kinds must still be counted: %v", unread.Counts)
	}
}

// A recent row is counted once, as skipped, and no finding comes from it.
func TestBillingExceptionsCountsASkippedRowOnce(t *testing.T) {
	rows := []shortsstore.BillingSubscription{billingRow(billingNow, "uid-c", "c@example.com", "canceled", withCustomer("cus_c"), withRecent(billingNow, 3*time.Minute))}
	alive := []webAliveSubscription{{CustomerID: "cus_c", SubscriptionID: "sub_c", Status: "active", Email: "c@example.com"}}
	res := billingExceptions(exceptionInput{Now: billingNow, Rows: rows, Alive: alive, AliveOK: true})
	if res.SkippedRecent != 1 {
		t.Fatalf("SkippedRecent = %d, want 1 (the row was skipped once, not once per check)", res.SkippedRecent)
	}
}

// Severity order is the rule: money taken with no access before access with no
// money, both before the mirror's own tidy-ups, and a stale id last of all.
func TestBillingExceptionsOrdersBySeverity(t *testing.T) {
	rows := []shortsstore.BillingSubscription{
		billingRow(billingNow, "uid-b", "b@example.com", "past_due"),
		billingRow(billingNow, "uid-z", "z@example.com", "active", withPeriodEnd(nil)),
		billingRow(billingNow, "uid-c", "c@example.com", "canceled", withCustomer("cus_c"), withSubID("sub_c")),
	}
	alive := []webAliveSubscription{{CustomerID: "cus_c", SubscriptionID: "sub_c", Status: "active", Email: "c@example.com", MetadataUserID: "uid-c"}}
	alive = append(alive, webAliveSubscription{CustomerID: "cus_ghost", SubscriptionID: "sub_ghost", Status: "active", Email: "ghost@example.com"})
	res := billingExceptions(exceptionInput{Now: billingNow, Rows: rows, Alive: alive, AliveOK: true})
	var got []string
	for _, f := range res.Findings {
		got = append(got, f.Kind)
	}
	// c and ghost are both paid without mirror (c's row grants nothing; ghost has
	// none), ordered by email. z is active with no period end, and Stripe has no
	// live subscription for its customer.
	want := []string{kindPaidWithoutMirror, kindPaidWithoutMirror, kindEntitledWithoutStripe, kindPastDue, kindMissingPeriodEnd}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("order = %v, want %v", got, want)
	}
}

// Within the sweep, a customer's best live subscription is the one the row is set
// against: an unpaid sibling does not demote an active one.
func TestBestAliveByCustomerRanksWithinACustomer(t *testing.T) {
	got := bestAliveByCustomer([]webAliveSubscription{
		{CustomerID: "cus_1", SubscriptionID: "sub_u", Status: "unpaid"},
		{CustomerID: "cus_1", SubscriptionID: "sub_a", Status: "active"},
		{CustomerID: "cus_2", SubscriptionID: "sub_p", Status: "past_due"},
	})
	if len(got) != 2 || got[0].SubscriptionID != "sub_a" || got[1].SubscriptionID != "sub_p" {
		t.Fatalf("best = %+v", got)
	}
}

// withMetadata is a Stripe subscription that records the user id it was bought for.
func withMetadata(s webSubscription, uid string) webSubscription {
	s.MetadataUserID = uid
	return s
}

// A live Stripe subscription recorded for one user, on a row keyed to another, is a
// finding: the real payer has no row, and the row's user holds the access. Only a
// live subscription counts, a blank id counts for nothing, and a recent row is left
// out like any other.
func TestSubscriptionUserMismatchInDrift(t *testing.T) {
	periodEnd := billingNow.Add(20 * 24 * time.Hour)
	cases := []struct {
		name     string
		rows     []shortsstore.BillingSubscription
		views    []stripeCustomerView
		stripeOK bool
		want     []string
	}{
		{
			name:     "a live subscription recorded for another user is a mismatch",
			rows:     []shortsstore.BillingSubscription{billingRow(billingNow, "uid-stale", "stale@example.com", "active")},
			views:    []stripeCustomerView{stripeView("cus_uid-stale", withMetadata(stripeSub("sub_uid-stale", "active", periodEnd), "uid-new"))},
			stripeOK: true,
			want:     []string{kindSubscriptionUserMismatch},
		},
		{
			name: "a past-due live subscription recorded for another user is a mismatch",
			rows: []shortsstore.BillingSubscription{billingRow(billingNow, "uid-stale", "stale@example.com", "past_due", func(r *shortsstore.BillingSubscription) {
				// Same period end as Stripe, so only the user mismatch differs.
				r.CurrentPeriodEnd = billingRFC(periodEnd)
			})},
			views:    []stripeCustomerView{stripeView("cus_uid-stale", withMetadata(stripeSub("sub_uid-stale", "past_due", periodEnd), "uid-new"))},
			stripeOK: true,
			want:     []string{kindSubscriptionUserMismatch},
		},
		{
			name:     "the same user on both sides is not a mismatch",
			rows:     []shortsstore.BillingSubscription{billingRow(billingNow, "uid-a", "a@example.com", "active")},
			views:    []stripeCustomerView{stripeView("cus_uid-a", withMetadata(stripeSub("sub_uid-a", "active", periodEnd), "uid-a"))},
			stripeOK: true,
			want:     []string{},
		},
		{
			name:     "a subscription with no recorded user is not a mismatch",
			rows:     []shortsstore.BillingSubscription{billingRow(billingNow, "uid-a", "a@example.com", "active")},
			views:    []stripeCustomerView{stripeView("cus_uid-a", stripeSub("sub_uid-a", "active", periodEnd))},
			stripeOK: true,
			want:     []string{},
		},
		{
			// Only a live subscription is the customer's answer. An ended one that names
			// another user says nothing about who pays now.
			name:     "an ended subscription recorded for another user is not a mismatch",
			rows:     []shortsstore.BillingSubscription{billingRow(billingNow, "uid-stale", "stale@example.com", "canceled")},
			views:    []stripeCustomerView{stripeView("cus_uid-stale", withMetadata(stripeSub("sub_uid-stale", "canceled", periodEnd), "uid-new"))},
			stripeOK: true,
			want:     []string{},
		},
		{
			name:     "a recent row is left out of the mismatch check",
			rows:     []shortsstore.BillingSubscription{billingRow(billingNow, "uid-stale", "stale@example.com", "active", withRecent(billingNow, 5*time.Minute))},
			views:    []stripeCustomerView{stripeView("cus_uid-stale", withMetadata(stripeSub("sub_uid-stale", "active", periodEnd), "uid-new"))},
			stripeOK: true,
			want:     []string{},
		},
		{
			name:     "Stripe unread: the mismatch is not checked",
			rows:     []shortsstore.BillingSubscription{billingRow(billingNow, "uid-stale", "stale@example.com", "active")},
			views:    []stripeCustomerView{stripeView("cus_uid-stale", withMetadata(stripeSub("sub_uid-stale", "active", periodEnd), "uid-new"))},
			stripeOK: false,
			want:     []string{},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			findings, _ := billingDrift(billingNow, tc.rows, tc.views, tc.stripeOK)
			if got := kindsOf(findings); !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("kinds = %v, want %v; findings %+v", got, tc.want, findings)
			}
		})
	}
}

// The mismatch is set against the customer's BEST live subscription, so a sibling
// that was bought for someone else does not stand in for the one that is current.
func TestSubscriptionUserMismatchUsesTheBestLiveSubscription(t *testing.T) {
	periodEnd := billingNow.Add(20 * 24 * time.Hour)
	old := billingNow.Add(-60 * 24 * time.Hour)
	newest := billingNow.Add(-1 * 24 * time.Hour)
	rows := []shortsstore.BillingSubscription{billingRow(billingNow, "uid-new", "new@example.com", "active")}
	views := []stripeCustomerView{stripeView("cus_uid-new",
		withMetadata(stripeSubCreated("sub_old", "active", periodEnd, old), "uid-retired"),
		withMetadata(stripeSubCreated("sub_new", "active", periodEnd, newest), "uid-new"))}
	findings, _ := billingDrift(billingNow, rows, views, true)
	// The row names sub_uid-new, the customer's newest live subscription, which was
	// bought by the row's own user. So no mismatch. Its id is an earlier one, which
	// is a different finding and is allowed here.
	for _, f := range findings {
		if f.Kind == kindSubscriptionUserMismatch {
			t.Fatalf("findings = %+v; the newest live subscription was bought by the row's own user", findings)
		}
	}
}

// The detail names both user ids and nothing else: no email, no name, no Stripe id.
func TestSubscriptionUserMismatchDetailNamesTheTwoUserIDsOnly(t *testing.T) {
	periodEnd := billingNow.Add(20 * 24 * time.Hour)
	rows := []shortsstore.BillingSubscription{billingRow(billingNow, "uid-stale", "stale@example.com", "active")}
	views := []stripeCustomerView{stripeView("cus_uid-stale", withMetadata(stripeSub("sub_uid-stale", "active", periodEnd), "uid-new"))}
	findings, _ := billingDrift(billingNow, rows, views, true)
	if len(findings) != 1 || findings[0].Kind != kindSubscriptionUserMismatch {
		t.Fatalf("findings = %+v", findings)
	}
	detail := findings[0].Detail
	if !strings.Contains(detail, `"uid-new"`) || !strings.Contains(detail, `"uid-stale"`) {
		t.Fatalf("detail %q does not name both user ids", detail)
	}
	for _, leak := range []string{"@", "stale@example.com", "cus_", "sub_"} {
		if strings.Contains(detail, leak) {
			t.Fatalf("detail %q carries %q, which is not a user id", detail, leak)
		}
	}
}

// The severity of the new kind sits just below paid_without_mirror.
func TestSubscriptionUserMismatchSeverityIsJustBelowPaidWithoutMirror(t *testing.T) {
	if kindSeverity[kindSubscriptionUserMismatch] != kindSeverity[kindPaidWithoutMirror]+1 {
		t.Fatalf("severity %d, want paid_without_mirror (%d) + 1", kindSeverity[kindSubscriptionUserMismatch], kindSeverity[kindPaidWithoutMirror])
	}
	if kindSeverity[kindEntitledWithoutStripe] <= kindSeverity[kindSubscriptionUserMismatch] {
		t.Fatalf("entitled_without_stripe must rank below the mismatch")
	}
}

// The sweep applies the same rule to the live list, keyed by customer.
func TestSubscriptionUserMismatchInTheSweep(t *testing.T) {
	now := billingNow
	cases := []struct {
		name  string
		rows  []shortsstore.BillingSubscription
		alive []webAliveSubscription
		want  []string
	}{
		{
			name:  "a live customer recorded for another user is a mismatch",
			rows:  []shortsstore.BillingSubscription{billingRow(now, "uid-stale", "stale@example.com", "active", withCustomer("cus_X"), withSubID("sub_X"))},
			alive: []webAliveSubscription{{CustomerID: "cus_X", SubscriptionID: "sub_X", Status: "active", Email: "new@example.com", MetadataUserID: "uid-new"}},
			want:  []string{kindSubscriptionUserMismatch},
		},
		{
			name:  "the same user on both sides is not a mismatch",
			rows:  []shortsstore.BillingSubscription{billingRow(now, "uid-a", "a@example.com", "active", withCustomer("cus_A"), withSubID("sub_A"))},
			alive: []webAliveSubscription{{CustomerID: "cus_A", SubscriptionID: "sub_A", Status: "active", MetadataUserID: "uid-a"}},
			want:  []string{},
		},
		{
			name:  "a live customer with no recorded user is not a mismatch",
			rows:  []shortsstore.BillingSubscription{billingRow(now, "uid-a", "a@example.com", "active", withCustomer("cus_A"), withSubID("sub_A"))},
			alive: []webAliveSubscription{{CustomerID: "cus_A", SubscriptionID: "sub_A", Status: "active"}},
			want:  []string{},
		},
		{
			name:  "a recent row is skipped, not reported",
			rows:  []shortsstore.BillingSubscription{billingRow(now, "uid-stale", "stale@example.com", "active", withCustomer("cus_X"), withSubID("sub_X"), withRecent(now, 3*time.Minute))},
			alive: []webAliveSubscription{{CustomerID: "cus_X", SubscriptionID: "sub_X", Status: "active", MetadataUserID: "uid-new"}},
			want:  []string{},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			res := billingExceptions(exceptionInput{Now: now, Rows: tc.rows, Alive: tc.alive, AliveOK: true})
			var got []string
			for _, f := range res.Findings {
				got = append(got, f.Kind)
			}
			if got == nil {
				got = []string{}
			}
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("kinds = %v, want %v; findings %+v", got, tc.want, res.Findings)
			}
		})
	}
}

// The sweep names both user ids in the detail, and the row it reports is the stale
// one, since that is the row a reader must go and fix.
func TestSubscriptionUserMismatchInTheSweepNamesBothIDsAndTheRow(t *testing.T) {
	now := billingNow
	rows := []shortsstore.BillingSubscription{billingRow(now, "uid-stale", "stale@example.com", "active", withCustomer("cus_X"), withSubID("sub_X"))}
	alive := []webAliveSubscription{{CustomerID: "cus_X", SubscriptionID: "sub_X", Status: "active", Email: "new@example.com", MetadataUserID: "uid-new"}}
	res := billingExceptions(exceptionInput{Now: now, Rows: rows, Alive: alive, AliveOK: true})
	if len(res.Findings) != 1 {
		t.Fatalf("findings = %+v", res.Findings)
	}
	f := res.Findings[0]
	if f.UserID != "uid-stale" || f.Email != "stale@example.com" {
		t.Fatalf("row = %+v, want the stale row the finding is about", f)
	}
	if !strings.Contains(f.Detail, `"uid-new"`) || !strings.Contains(f.Detail, `"uid-stale"`) || strings.Contains(f.Detail, "@") {
		t.Fatalf("detail %q must name the two user ids and no email", f.Detail)
	}
	if res.Counts[kindSubscriptionUserMismatch] != 1 {
		t.Fatalf("counts = %v", res.Counts)
	}
}
