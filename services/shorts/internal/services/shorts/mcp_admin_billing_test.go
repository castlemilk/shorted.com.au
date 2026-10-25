package shorts

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/castlemilk/shorted.com.au/services/shorts/internal/jobmonitor"
	"github.com/castlemilk/shorted.com.au/services/shorts/internal/mcp"
	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
)

const billingTestSecret = "internal-test-secret"

// billingStore is the BillingStore the tools read, with each read's failure
// settable on its own.
type billingStore struct {
	rows      []shortsstore.BillingSubscription
	rowsErr   error
	chat      *shortsstore.ChatUsage
	chatErr   error
	events    *shortsstore.ChatUsageEvents
	eventsErr error
	months    []shortsstore.APIUsageMonth
	apiErr    error
}

func (f *billingStore) BillingSubscriptionsFor(_ context.Context, uid, email string) ([]shortsstore.BillingSubscription, bool, error) {
	if f.rowsErr != nil {
		return nil, false, f.rowsErr
	}
	var out []shortsstore.BillingSubscription
	for _, r := range f.rows {
		if (uid != "" && r.UserID == uid) || (email != "" && strings.EqualFold(r.UserEmail, email)) {
			out = append(out, r)
		}
	}
	return out, false, nil
}

func (f *billingStore) BillingSubscriptionsAll(_ context.Context, limit int) ([]shortsstore.BillingSubscription, bool, error) {
	if f.rowsErr != nil {
		return nil, false, f.rowsErr
	}
	if len(f.rows) > limit {
		return f.rows[:limit], true, nil
	}
	return f.rows, false, nil
}

// BillingSubscriptionsByCustomers returns the rows whose customer is asked for,
// whatever their user id or email, as the store does.
func (f *billingStore) BillingSubscriptionsByCustomers(_ context.Context, customerIDs []string) ([]shortsstore.BillingSubscription, error) {
	if f.rowsErr != nil {
		return nil, f.rowsErr
	}
	var out []shortsstore.BillingSubscription
	for _, r := range f.rows {
		if slices.Contains(customerIDs, r.StripeCustomerID) {
			out = append(out, r)
		}
	}
	return out, nil
}

// An unset chat read is an empty history, as the store returns for a user with none.
func (f *billingStore) ChatUsage(context.Context, []string) (*shortsstore.ChatUsage, error) {
	if f.chat == nil && f.chatErr == nil {
		return &shortsstore.ChatUsage{}, nil
	}
	return f.chat, f.chatErr
}

func (f *billingStore) ChatUsageEvents(context.Context, []string) (*shortsstore.ChatUsageEvents, error) {
	if f.events == nil && f.eventsErr == nil {
		return &shortsstore.ChatUsageEvents{SendsByOutcome: map[string]int{}}, nil
	}
	return f.events, f.eventsErr
}

func (f *billingStore) APIUsageByMonth(context.Context, []string) ([]shortsstore.APIUsageMonth, error) {
	return f.months, f.apiErr
}

// billingAccounts is the Firebase reader; Lookup answers from byEmail.
type billingAccounts struct {
	byEmail map[string]*firebaseUser
	err     error
}

func (f billingAccounts) Summary(context.Context) (*firebaseUserSummary, error) {
	return nil, errors.New("not used")
}

func (f billingAccounts) List(context.Context, string, string, int, int) (*firebaseUserPage, error) {
	return nil, errors.New("not used")
}

func (f billingAccounts) Lookup(_ context.Context, email string) (*firebaseUser, error) {
	if f.err != nil {
		return nil, f.err
	}
	return f.byEmail[email], nil
}

func (f billingAccounts) LookupUID(_ context.Context, uid string) (*firebaseUser, error) {
	if f.err != nil {
		return nil, f.err
	}
	for _, u := range f.byEmail {
		if u != nil && u.UID == uid {
			return u, nil
		}
	}
	return nil, nil
}

// billingWeb is the web app's billing and probe routes. It is served over HTTP
// so the real client is what the tests exercise.
type billingWeb struct {
	customers     map[string]webCustomerView // "email:<e>" or "id:<customer>"
	alive         webAliveList
	billingStatus int // when set, every billing call gets this status
	probeStatus   int
	probeBody     string
	seenSecrets   []string
	actions       []string
	// ambiguous answers an email with the web's ambiguous shape: no customer and the
	// ids it matched. Keyed by the email exactly as it arrives.
	ambiguous map[string][]string
	// failCustomer is a customer id whose read fails with 500.
	failCustomer string
	// emailsSeen is every email the billing route was asked with, exactly as sent.
	emailsSeen []string
	// customerReads counts the by-id reads.
	customerReads int
}

func (w *billingWeb) ServeHTTP(rw http.ResponseWriter, r *http.Request) {
	w.seenSecrets = append(w.seenSecrets, r.Header.Get("x-internal-secret"))
	if r.Header.Get("x-internal-secret") != billingTestSecret {
		rw.WriteHeader(http.StatusUnauthorized)
		return
	}
	switch r.URL.Path {
	case "/api/internal/billing":
		if w.billingStatus != 0 {
			rw.WriteHeader(w.billingStatus)
			return
		}
		var req webBillingRequest
		_ = json.NewDecoder(r.Body).Decode(&req)
		w.actions = append(w.actions, req.Action)
		if req.Action == "alive" {
			_ = json.NewEncoder(rw).Encode(w.alive)
			return
		}
		if req.Email != "" {
			w.emailsSeen = append(w.emailsSeen, req.Email)
			if ids, ok := w.ambiguous[req.Email]; ok {
				_ = json.NewEncoder(rw).Encode(webCustomerView{Ambiguous: true, CustomerIDs: ids})
				return
			}
		}
		if req.CustomerID != "" {
			w.customerReads++
			if req.CustomerID == w.failCustomer {
				rw.WriteHeader(http.StatusInternalServerError)
				return
			}
		}
		key := "email:" + req.Email
		if req.CustomerID != "" {
			key = "id:" + req.CustomerID
		}
		view, ok := w.customers[key]
		if !ok {
			view = webCustomerView{} // no customer: "customer": null
		}
		_ = json.NewEncoder(rw).Encode(view)
	case "/api/internal/paid-probe":
		rw.WriteHeader(w.probeStatus)
		_, _ = io.WriteString(rw, w.probeBody)
	default:
		rw.WriteHeader(http.StatusNotFound)
	}
}

// billingFixture is one subject's world: the store, the accounts and the web app.
type billingFixture struct {
	store    *billingStore
	accounts billingAccounts
	web      *billingWeb
}

// source builds the admin source over the fixture, with the web app served on a
// test server and the Collector unconfigured (Telesis is tested separately).
func (f billingFixture) source(t *testing.T) *adminMCPSource {
	t.Helper()
	srv := httptest.NewServer(f.web)
	t.Cleanup(srv.Close)
	return &adminMCPSource{
		Collector: jobmonitor.NewCollector(jobmonitor.Config{}),
		billing:   f.store,
		users:     f.accounts,
		web:       &adminWebClient{checkURL: srv.URL + "/api/internal/admin-check", secret: billingTestSecret, client: srv.Client()},
	}
}

// billingClock is the real clock: the audit reads time.Now, so the fixtures are
// placed relative to it, not to the fixed clock the rule tests use.
func billingClock() time.Time { return time.Now().UTC() }

func billingAda() *firebaseUser {
	return &firebaseUser{UID: "uid-a", Email: "ada@example.com", EmailVerified: true, Providers: []string{"google.com"},
		CreatedAt: "2026-01-02T03:04:05Z", LastSignInAt: "2026-10-22T01:00:00Z"}
}

// billingAdaRow is Ada's mirror row: active premium, two hours old, a period
// that runs another twenty days.
func billingAdaRow() shortsstore.BillingSubscription {
	updated := billingClock().Add(-2 * time.Hour)
	created := billingClock().Add(-30 * 24 * time.Hour)
	return shortsstore.BillingSubscription{
		UserID: "uid-a", UserEmail: "ada@example.com", StripeCustomerID: "cus_A", StripeSubscriptionID: "sub_A",
		Status: "active", Tier: "premium", CurrentPeriodEnd: billingRFC(billingClock().Add(20 * 24 * time.Hour)),
		CreatedAt: &created, UpdatedAt: &updated,
	}
}

// billingAdaCustomer is Ada's Stripe customer, as the web app reads it.
func billingAdaCustomer(periodEnd time.Time) webCustomerView {
	created := "2026-09-01T00:00:00Z"
	return webCustomerView{
		Customer: &webCustomer{ID: "cus_A", Created: &created},
		Subscriptions: []webSubscription{{
			ID: "sub_A", Status: "active", Tier: "premium", PriceID: "price_A", Amount: new(int64(2900)), Currency: "aud",
			Interval: "month", CurrentPeriodEnd: billingRFC(periodEnd), Created: &created, MetadataUserID: "uid-a",
		}},
		LatestInvoice: &webInvoice{Status: "paid", AmountPaid: 2900, Currency: "aud", Created: &created, PaidAt: &created},
	}
}

func billingHealthyFixture() billingFixture {
	periodEnd := billingClock().Add(20 * 24 * time.Hour)
	chatLast := billingClock().Add(-time.Hour)
	monthStart := time.Now().UTC()
	monthStart = time.Date(monthStart.Year(), monthStart.Month(), 1, 0, 0, 0, 0, time.UTC)
	return billingFixture{
		store: &billingStore{
			rows:   []shortsstore.BillingSubscription{billingAdaRow()},
			chat:   &shortsstore.ChatUsage{Conversations: 2, UserMessagesLast30Days: 5, LastUserMessageAt: &chatLast},
			events: &shortsstore.ChatUsageEvents{SendsByOutcome: map[string]int{"ok": 3, "limited": 1}, InputTokensLast30: 100, OutputTokensLast30: 200},
			months: []shortsstore.APIUsageMonth{{Identifier: "user:uid-a", Month: monthStart, Requests: 42}},
		},
		accounts: billingAccounts{byEmail: map[string]*firebaseUser{"ada@example.com": billingAda()}},
		web: &billingWeb{customers: map[string]webCustomerView{
			"email:ada@example.com": billingAdaCustomer(periodEnd),
			"id:cus_A":              billingAdaCustomer(periodEnd),
		}},
	}
}

func sourceStatus(sources []mcp.JobSource, name string) string {
	for _, s := range sources {
		if s.Name == name {
			return s.Status
		}
	}
	return "missing"
}

// The whole check, healthy: every section is filled, the verdict is the
// product's, and no Stripe id appears anywhere but the dashboard link.
func TestCheckSubscriptionReadsEverySourceAndKeepsStripeIdsOut(t *testing.T) {
	src := billingHealthyFixture().source(t)
	out, err := src.CheckSubscription(context.Background(), mcp.CheckSubscriptionInput{Email: "ada@example.com"})
	if err != nil {
		t.Fatal(err)
	}
	if out.Account == nil || !out.Account.Exists || out.Account.UserID != "uid-a" {
		t.Fatalf("account = %+v", out.Account)
	}
	if len(out.Mirror) != 1 || out.Mirror[0].StripeDashboardURL != "https://dashboard.stripe.com/customers/cus_A" || !out.Mirror[0].HasStripeSubscription {
		t.Fatalf("mirror = %+v", out.Mirror)
	}
	if e := out.Entitlement; e == nil || !e.Entitled || e.Reason != "active" || e.Source != "stripe" || e.Basis != "firebase account" || e.UserID != "uid-a" {
		t.Fatalf("entitlement = %+v", out.Entitlement)
	}
	if len(out.Stripe) != 1 || out.Stripe[0].LookedUpBy != "customer id" || len(out.Stripe[0].Subscriptions) != 1 || out.Stripe[0].LatestInvoice == nil {
		t.Fatalf("stripe = %+v (the email and the customer id name one customer and must read once)", out.Stripe)
	}
	if len(out.Drift) != 0 {
		t.Fatalf("a matching mirror and Stripe have drift %+v", out.Drift)
	}
	if out.Usage == nil || out.Usage.Chat == nil || out.Usage.Chat.Conversations != 2 || out.Usage.ChatSends == nil || out.Usage.ChatSends.SendsByOutcome["ok"] != 3 {
		t.Fatalf("usage = %+v", out.Usage)
	}
	if len(out.Usage.API) != 3 || out.Usage.API[0].Requests != 42 {
		t.Fatalf("api usage = %+v", out.Usage.API)
	}
	for _, name := range []string{sourceAccounts, sourceSubscriptions, sourceStripe, sourceChatUsage, sourceChatUsageEvents, sourceAPIUsage} {
		if got := sourceStatus(out.Sources, name); got != "available" {
			t.Errorf("source %s = %s, want available", name, got)
		}
	}

	raw, _ := json.Marshal(out)
	scrubbed := strings.ReplaceAll(string(raw), "https://dashboard.stripe.com/customers/cus_A", "")
	for _, id := range []string{"cus_", "sub_", "price_"} {
		if strings.Contains(scrubbed, id) {
			t.Fatalf("a Stripe id (%s) reached the output outside the dashboard link: %s", id, raw)
		}
	}
}

// Each source that fails is named, and its section is null or empty with the
// source marked unavailable. Nothing reads as a clean "none".
func TestCheckSubscriptionNamesEachFailedSource(t *testing.T) {
	f := billingHealthyFixture()
	f.accounts.err = errors.New("firebase down")
	f.store.chatErr = fmt.Errorf("%w: undefined table", shortsstore.ErrRelationMissing)
	f.store.eventsErr = fmt.Errorf("%w: undefined table", shortsstore.ErrRelationMissing)
	f.store.apiErr = errors.New("quota table down")
	f.web.billingStatus = http.StatusInternalServerError
	src := f.source(t)

	out, err := src.CheckSubscription(context.Background(), mcp.CheckSubscriptionInput{Email: "ada@example.com"})
	if err != nil {
		t.Fatal(err)
	}
	if out.Account != nil {
		t.Errorf("account = %+v, want null when Firebase could not be read", out.Account)
	}
	if out.Usage == nil || out.Usage.Chat != nil || out.Usage.ChatSends != nil || out.Usage.API != nil {
		t.Errorf("usage = %+v, want every unread part null", out.Usage)
	}
	if len(out.Stripe) != 0 {
		t.Errorf("stripe = %+v, want none when the web app did not answer", out.Stripe)
	}
	for name, want := range map[string]string{
		sourceAccounts: "unavailable", sourceStripe: "unavailable", sourceChatUsage: "unavailable",
		sourceChatUsageEvents: "unavailable", sourceAPIUsage: "unavailable", sourceSubscriptions: "available",
	} {
		if got := sourceStatus(out.Sources, name); got != want {
			t.Errorf("source %s = %s, want %s", name, got, want)
		}
	}
	// Stripe was not read, so the Stripe-dependent drift did not run; the note says so.
	if len(out.Drift) != 0 || !hasNote(out.Notes, "Stripe was not read") {
		t.Errorf("drift %+v, notes %v: the Stripe-dependent checks must be named as not run", out.Drift, out.Notes)
	}
	if e := out.Entitlement; e == nil || !e.Entitled {
		t.Errorf("entitlement = %+v; the mirror was readable, so the verdict stands", e)
	}
	raw, _ := json.Marshal(out)
	if !strings.Contains(string(raw), `"name":"chat_usage_events","status":"unavailable","detail":"not in this database`) {
		t.Errorf("a missing ledger must say it is not in this database, not zero: %s", raw)
	}
}

func hasNote(notes []string, substr string) bool {
	for _, n := range notes {
		if strings.Contains(n, substr) {
			return true
		}
	}
	return false
}

// A mirror that cannot be read leaves no verdict to give, except an operator
// grant, which the product checks before the store.
func TestCheckSubscriptionWithoutTheMirrorIsUnknownUnlessGranted(t *testing.T) {
	f := billingHealthyFixture()
	f.store.rowsErr = errors.New("db down")
	out, err := f.source(t).CheckSubscription(context.Background(), mcp.CheckSubscriptionInput{Email: "ada@example.com"})
	if err != nil {
		t.Fatal(err)
	}
	if out.Entitlement != nil {
		t.Fatalf("entitlement = %+v; an unreadable mirror must not give a verdict", out.Entitlement)
	}
	if sourceStatus(out.Sources, sourceSubscriptions) != "unavailable" || len(out.Mirror) != 0 || len(out.Drift) != 0 {
		t.Fatalf("sources %+v, mirror %+v, drift %+v", out.Sources, out.Mirror, out.Drift)
	}

	t.Setenv(InternalTierUsersEnv, "uid-a")
	out, err = f.source(t).CheckSubscription(context.Background(), mcp.CheckSubscriptionInput{Email: "ada@example.com"})
	if err != nil {
		t.Fatal(err)
	}
	if e := out.Entitlement; e == nil || !e.Entitled || e.Reason != "internal_grant" || e.Source != "internal" {
		t.Fatalf("granted entitlement = %+v", out.Entitlement)
	}
}

// The entitlement is the product's own verdict, so a period that ended is
// shown as ended here, whatever the status says.
func TestCheckSubscriptionReportsTheProductsVerdict(t *testing.T) {
	f := billingHealthyFixture()
	ended := billingClock().Add(-(periodEndGrace + 24*time.Hour))
	f.store.rows[0].CurrentPeriodEnd = billingRFC(ended)
	f.web.customers["email:ada@example.com"] = billingAdaCustomer(ended)
	f.web.customers["id:cus_A"] = billingAdaCustomer(ended)
	out, err := f.source(t).CheckSubscription(context.Background(), mcp.CheckSubscriptionInput{Email: "ada@example.com"})
	if err != nil {
		t.Fatal(err)
	}
	if e := out.Entitlement; e == nil || e.Entitled || e.Reason != "period_ended" {
		t.Fatalf("entitlement = %+v, want period_ended", out.Entitlement)
	}
	// Stripe still says active, on the same ended period. The row grants nothing
	// because its period is past the grace, so the customer Stripe calls paying is
	// paid without access. That is the finding, and the periods themselves agree.
	if len(out.Drift) != 1 || out.Drift[0].Kind != kindPaidWithoutMirror {
		t.Fatalf("drift = %+v, want paid_without_mirror alone (the periods agree)", out.Drift)
	}
}

// A user id alone has no email for the account lookup; the mirror row gives it.
func TestCheckSubscriptionByUserIDLearnsTheEmailFromItsRow(t *testing.T) {
	out, err := billingHealthyFixture().source(t).CheckSubscription(context.Background(), mcp.CheckSubscriptionInput{UserID: "uid-a"})
	if err != nil {
		t.Fatal(err)
	}
	if out.Email != "ada@example.com" || out.Account == nil || !out.Account.Exists {
		t.Fatalf("email %q, account %+v: the email must come from the row, then the account is found", out.Email, out.Account)
	}
	if out.Entitlement == nil || out.Entitlement.Basis != "user id" || out.Entitlement.UserID != "uid-a" {
		t.Fatalf("entitlement = %+v", out.Entitlement)
	}
}

// Two rows for one email under two user ids: both are reported, and each is a
// duplicate finding. The second user id only shows up because the email lookup
// finds it.
func TestCheckSubscriptionFindsDuplicateRowsUnderOtherUserIDs(t *testing.T) {
	f := billingHealthyFixture()
	old := billingClock().Add(-40 * 24 * time.Hour)
	f.store.rows = append(f.store.rows, shortsstore.BillingSubscription{
		UserID: "uid-z", UserEmail: "ada@example.com", StripeCustomerID: "cus_Z", StripeSubscriptionID: "sub_Z",
		Status: "canceled", Tier: "premium", CurrentPeriodEnd: billingRFC(old), UpdatedAt: &old,
	})
	out, err := f.source(t).CheckSubscription(context.Background(), mcp.CheckSubscriptionInput{Email: "ada@example.com"})
	if err != nil {
		t.Fatal(err)
	}
	if len(out.Mirror) != 2 {
		t.Fatalf("mirror has %d rows, want both", len(out.Mirror))
	}
	dups := 0
	for _, d := range out.Drift {
		if d.Kind == kindDuplicateEmail {
			dups++
		}
	}
	if dups != 1 {
		t.Fatalf("drift = %+v, want one duplicate_email finding for the email", out.Drift)
	}
}

// A row updated a minute ago is shown, marked, and left out of the drift check.
func TestCheckSubscriptionLeavesARecentRowOutOfDrift(t *testing.T) {
	f := billingHealthyFixture()
	fresh := billingClock().Add(-time.Minute)
	f.store.rows[0].UpdatedAt = &fresh
	f.web.customers["email:ada@example.com"] = webCustomerView{Customer: &webCustomer{ID: "cus_A"}, Subscriptions: []webSubscription{{
		ID: "sub_A", Status: "canceled", Tier: "premium", CurrentPeriodEnd: billingRFC(billingClock().Add(20 * 24 * time.Hour)),
	}}}
	f.web.customers["id:cus_A"] = f.web.customers["email:ada@example.com"]
	out, err := f.source(t).CheckSubscription(context.Background(), mcp.CheckSubscriptionInput{Email: "ada@example.com"})
	if err != nil {
		t.Fatal(err)
	}
	if len(out.Drift) != 0 {
		t.Fatalf("a row written a minute ago has drift %+v", out.Drift)
	}
	if !out.Mirror[0].RecentlyUpdated || !hasNote(out.Notes, "left out of the drift check") {
		t.Fatalf("mirror %+v, notes %v: the row must be marked and the skip named", out.Mirror[0], out.Notes)
	}
}

// Stripe has a live subscription for an email the mirror has never seen.
func TestCheckSubscriptionFindsPaidWithoutMirror(t *testing.T) {
	f := billingHealthyFixture()
	f.store.rows = nil
	f.accounts.byEmail["new@example.com"] = &firebaseUser{UID: "uid-new", Email: "new@example.com"}
	f.web.customers["email:new@example.com"] = webCustomerView{
		Customer:      &webCustomer{ID: "cus_new"},
		Subscriptions: []webSubscription{{ID: "sub_new", Status: "active", Tier: "premium", CurrentPeriodEnd: billingRFC(billingClock().Add(20 * 24 * time.Hour)), MetadataUserID: "uid-new"}},
	}
	out, err := f.source(t).CheckSubscription(context.Background(), mcp.CheckSubscriptionInput{Email: "new@example.com"})
	if err != nil {
		t.Fatal(err)
	}
	if len(out.Drift) != 1 || out.Drift[0].Kind != kindPaidWithoutMirror {
		t.Fatalf("drift = %+v, want paid_without_mirror", out.Drift)
	}
	if out.Entitlement == nil || out.Entitlement.Entitled || out.Entitlement.Reason != "no_subscription" {
		t.Fatalf("entitlement = %+v: no mirror row means no entitlement", out.Entitlement)
	}
}

// The account for the email is a different user id from the one given: the
// verdict is for the one given, and the note says the two differ.
func TestCheckSubscriptionNamesAUserIDThatDisagreesWithTheAccount(t *testing.T) {
	out, err := billingHealthyFixture().source(t).CheckSubscription(context.Background(), mcp.CheckSubscriptionInput{UserID: "uid-other", Email: "ada@example.com"})
	if err != nil {
		t.Fatal(err)
	}
	if !hasNote(out.Notes, "different user id") || out.Entitlement == nil || out.Entitlement.UserID != "uid-other" {
		t.Fatalf("notes %v, entitlement %+v", out.Notes, out.Entitlement)
	}
}

func TestCheckSubscriptionWithoutWebAppNamesStripeUnavailable(t *testing.T) {
	f := billingHealthyFixture()
	src := f.source(t)
	src.web = nil
	out, err := src.CheckSubscription(context.Background(), mcp.CheckSubscriptionInput{Email: "ada@example.com"})
	if err != nil {
		t.Fatal(err)
	}
	if got := sourceStatus(out.Sources, sourceStripe); got != "unavailable" {
		t.Fatalf("stripe = %s, want unavailable", got)
	}
	if !strings.Contains(sourceDetail(out.Sources, sourceStripe), "INTERNAL_SERVICE_SECRET") {
		t.Fatalf("the detail must say why: %+v", out.Sources)
	}
}

func sourceDetail(sources []mcp.JobSource, name string) string {
	for _, s := range sources {
		if s.Name == name {
			return s.Detail
		}
	}
	return ""
}

// --- list_billing_exceptions -------------------------------------------------

func TestBillingExceptionsSweepsTheWholeMirror(t *testing.T) {
	store := &billingStore{rows: []shortsstore.BillingSubscription{
		billingAdaRow(),
		{UserID: "uid-b", UserEmail: "bob@example.com", StripeCustomerID: "cus_B", StripeSubscriptionID: "sub_B", Status: "past_due", Tier: "premium", CurrentPeriodEnd: billingRFC(billingClock().Add(-20 * 24 * time.Hour)), UpdatedAt: new(billingClock().Add(-24 * time.Hour))},
	}}
	web := &billingWeb{alive: webAliveList{Subscriptions: []webAliveSubscription{
		{CustomerID: "cus_A", SubscriptionID: "sub_A", Status: "active", Tier: "premium", Email: "ada@example.com", MetadataUserID: "uid-a"},
		{CustomerID: "cus_ghost", SubscriptionID: "sub_ghost", Status: "active", Tier: "premium", Email: "ghost@example.com", MetadataUserID: "uid-ghost"},
	}}}
	src := billingFixture{store: store, web: web}.source(t)

	out, err := src.BillingExceptions(context.Background(), mcp.BillingExceptionsInput{Limit: 25})
	if err != nil {
		t.Fatal(err)
	}
	if out.Counts == nil || (*out.Counts)[kindPaidWithoutMirror] != 1 || (*out.Counts)[kindPastDue] != 1 {
		t.Fatalf("counts = %v", out.Counts)
	}
	if len(out.Rows) != 2 || out.Rows[0].Kind != kindPaidWithoutMirror || out.Rows[0].Email != "ghost@example.com" {
		t.Fatalf("rows = %+v, want the paid-without-mirror first", out.Rows)
	}
	if sourceStatus(out.Sources, sourceStripeLive) != "available" {
		t.Fatalf("sources = %+v", out.Sources)
	}
}

func TestBillingExceptionsLimitsRowsButNotCounts(t *testing.T) {
	var rows []shortsstore.BillingSubscription
	for i := range 4 {
		rows = append(rows, billingRow(billingClock(), fmt.Sprintf("uid-%d", i), fmt.Sprintf("p%d@example.com", i), "past_due"))
	}
	src := billingFixture{store: &billingStore{rows: rows}, web: &billingWeb{alive: webAliveList{}}}.source(t)
	out, err := src.BillingExceptions(context.Background(), mcp.BillingExceptionsInput{Limit: 2})
	if err != nil {
		t.Fatal(err)
	}
	if (*out.Counts)[kindPastDue] != 4 || len(out.Rows) != 2 || !hasNote(out.Notes, "first 2 of 4") {
		t.Fatalf("counts %v, rows %d, notes %v", *out.Counts, len(out.Rows), out.Notes)
	}
}

// A cut live list cannot show that a customer has no live subscription, so the
// kind is not checked; the note says so and the count is absent.
func TestBillingExceptionsSkipsEntitledWithoutStripeOnACutList(t *testing.T) {
	src := billingFixture{
		store: &billingStore{rows: []shortsstore.BillingSubscription{billingAdaRow()}},
		web:   &billingWeb{alive: webAliveList{Truncated: true}},
	}.source(t)
	out, err := src.BillingExceptions(context.Background(), mcp.BillingExceptionsInput{Limit: 25})
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := (*out.Counts)[kindEntitledWithoutStripe]; ok {
		t.Fatalf("counts = %v: entitled_without_stripe must not be counted from a cut list", *out.Counts)
	}
	if !hasNote(out.Notes, "cut at its limit") {
		t.Fatalf("notes = %v", out.Notes)
	}
}

// A mirror that cannot be read: no counts at all, not zeros.
func TestBillingExceptionsWithoutTheMirrorHasNoCounts(t *testing.T) {
	src := billingFixture{store: &billingStore{rowsErr: errors.New("db down")}, web: &billingWeb{}}.source(t)
	out, err := src.BillingExceptions(context.Background(), mcp.BillingExceptionsInput{Limit: 25})
	if err != nil {
		t.Fatal(err)
	}
	if out.Counts != nil || sourceStatus(out.Sources, sourceSubscriptions) != "unavailable" {
		t.Fatalf("counts %v, sources %+v: an unread mirror must be null, not zero", out.Counts, out.Sources)
	}
}

// Stripe unreadable: the two Stripe kinds are absent, and the mirror's own
// kinds still count.
func TestBillingExceptionsWithoutStripeNamesTheKindsNotChecked(t *testing.T) {
	store := &billingStore{rows: []shortsstore.BillingSubscription{billingRow(billingClock(), "uid-a", "a@example.com", "past_due")}}
	src := billingFixture{store: store, web: &billingWeb{billingStatus: http.StatusInternalServerError}}.source(t)
	out, err := src.BillingExceptions(context.Background(), mcp.BillingExceptionsInput{Limit: 25})
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := (*out.Counts)[kindPaidWithoutMirror]; ok {
		t.Fatalf("counts = %v: paid_without_mirror was not checked", *out.Counts)
	}
	if (*out.Counts)[kindPastDue] != 1 || !hasNote(out.Notes, "were not checked") {
		t.Fatalf("counts %v, notes %v", *out.Counts, out.Notes)
	}
}

// --- helpers -----------------------------------------------------------------

func TestAPIUsageMonthsReportsThreeMonthsNewestFirst(t *testing.T) {
	now := time.Date(2026, 10, 23, 12, 0, 0, 0, time.UTC)
	rows := []shortsstore.APIUsageMonth{
		{Month: time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC), Requests: 7},
		{Month: time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC), Requests: 5},
		{Month: time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC), Requests: 3},
		{Month: time.Date(2026, 6, 1, 0, 0, 0, 0, time.UTC), Requests: 99},
	}
	got := apiUsageMonths(now, rows)
	want := []mcp.APIUsageMonthRow{{Month: "2026-10", Requests: 12}, {Month: "2026-09", Requests: 3}, {Month: "2026-08", Requests: 0}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("months = %+v, want %+v (a month with no row is zero requests recorded, not missing)", got, want)
	}
}

func TestBillingStoreComesOnlyFromPostgres(t *testing.T) {
	if billingStoreFrom(nil) != nil {
		t.Fatal("no people store must give no billing store")
	}
	if billingStoreFrom(&fakePeopleStore{}) != nil {
		t.Fatal("a store without the billing reads must give none, not a broken one")
	}
}

// The paying-user list shows the product's verdict for each row, so a row that
// grants nothing reads as such and the list cannot disagree with the features.
func TestPayingRowCarriesTheProductsVerdict(t *testing.T) {
	now := time.Date(2026, 10, 23, 12, 0, 0, 0, time.UTC)
	end := now.Add(10 * 24 * time.Hour)
	ended := now.Add(-(periodEndGrace + 24*time.Hour))
	pastGrace := now.Add(-(pastDueGrace + 24*time.Hour))
	cases := []struct {
		name   string
		row    shortsstore.AdminSubscription
		want   bool
		reason string
	}{
		{"active and in period", shortsstore.AdminSubscription{UserID: "uid-1", Status: "active", Tier: "premium", CurrentPeriodEnd: &end}, true, "active"},
		{"period ended three days ago", shortsstore.AdminSubscription{UserID: "uid-2", Status: "active", Tier: "premium", CurrentPeriodEnd: &ended}, false, "period_ended"},
		{"active on an unpaid tier", shortsstore.AdminSubscription{UserID: "uid-3", Status: "active", Tier: "free", CurrentPeriodEnd: &end}, false, "unpaid_tier"},
		{"past due inside its 14 day grace keeps paid access", shortsstore.AdminSubscription{UserID: "uid-4", Status: "past_due", Tier: "premium", CurrentPeriodEnd: &end}, true, "past_due_grace"},
		{"past due past its 14 day grace", shortsstore.AdminSubscription{UserID: "uid-5", Status: "past_due", Tier: "premium", CurrentPeriodEnd: &pastGrace}, false, "past_due_grace_ended"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			row := payingRow(tc.row, now)
			if row.Entitled != tc.want || row.EntitlementReason != tc.reason {
				t.Fatalf("entitled %v reason %s, want %v %s", row.Entitled, row.EntitlementReason, tc.want, tc.reason)
			}
		})
	}
	t.Setenv(InternalTierUsersEnv, "uid-granted")
	granted := payingRow(shortsstore.AdminSubscription{UserID: "uid-granted", Status: "canceled", Tier: "free"}, now)
	if !granted.Entitled || granted.EntitlementReason != "internal_grant" {
		t.Fatalf("granted row = %+v", granted)
	}
}

// An email that names several Stripe customers is read customer by customer, and
// the Stripe source says the answer is partial. Each matched customer is compared
// with its own row, so a second customer with no row is still found.
func TestAmbiguousEmailReadsEveryMatchedCustomerAndSaysSo(t *testing.T) {
	f := billingHealthyFixture()
	periodEnd := billingClock().Add(20 * 24 * time.Hour)
	f.web.ambiguous = map[string][]string{"ada@example.com": {"cus_A", "cus_B"}}
	f.web.customers["id:cus_B"] = webCustomerView{
		Customer:      &webCustomer{ID: "cus_B"},
		Subscriptions: []webSubscription{{ID: "sub_B", Status: "active", Tier: "premium", CurrentPeriodEnd: billingRFC(periodEnd), MetadataUserID: "uid-b"}},
	}
	out, err := f.source(t).CheckSubscription(context.Background(), mcp.CheckSubscriptionInput{Email: "ada@example.com", EmailAsTyped: "ada@example.com"})
	if err != nil {
		t.Fatal(err)
	}
	if len(out.Stripe) != 2 {
		t.Fatalf("stripe = %+v, want both matched customers read", out.Stripe)
	}
	if got := sourceStatus(out.Sources, sourceStripe); got != "partial" {
		t.Fatalf("stripe source = %s, want partial", got)
	}
	if !hasNote(out.Notes, "matches 2 Stripe customers") {
		t.Fatalf("notes = %v, want the ambiguity named", out.Notes)
	}
	// The second customer has a live subscription and no row: found, not hidden.
	if len(out.Drift) != 1 || out.Drift[0].Kind != kindPaidWithoutMirror {
		t.Fatalf("drift = %+v, want the second customer paid without mirror", out.Drift)
	}
}

// The admin's email goes to Stripe exactly as typed. The mirror and the account
// are read with the normalised form.
func TestStripeIsAskedWithTheEmailAsTyped(t *testing.T) {
	f := billingHealthyFixture()
	f.web.customers["email:Ada@Example.COM"] = billingAdaCustomer(billingClock().Add(20 * 24 * time.Hour))
	src := f.source(t)
	out, err := src.CheckSubscription(context.Background(), mcp.CheckSubscriptionInput{Email: "ada@example.com", EmailAsTyped: "Ada@Example.COM"})
	if err != nil {
		t.Fatal(err)
	}
	if len(f.web.emailsSeen) == 0 || f.web.emailsSeen[0] != "Ada@Example.COM" {
		t.Fatalf("web was asked with %v, want the email as typed", f.web.emailsSeen)
	}
	if out.Email != "ada@example.com" {
		t.Fatalf("output email = %q, want the normalised form", out.Email)
	}
}

// A customer the ambiguous email matched that cannot be read is an unavailable
// Stripe source, not a partial one: the answer is then not known at all.
func TestAmbiguousCustomerReadFailureIsUnavailable(t *testing.T) {
	f := billingHealthyFixture()
	f.web.ambiguous = map[string][]string{"ada@example.com": {"cus_A", "cus_broken"}}
	f.web.failCustomer = "cus_broken"
	out, err := f.source(t).CheckSubscription(context.Background(), mcp.CheckSubscriptionInput{Email: "ada@example.com"})
	if err != nil {
		t.Fatal(err)
	}
	if got := sourceStatus(out.Sources, sourceStripe); got != "unavailable" {
		t.Fatalf("stripe source = %s, want unavailable", got)
	}
}

// An ambiguous email is read for at most billingMaxAmbiguousCustomers customers. The
// rest are named, and the answer stays partial.
func TestAmbiguousEmailIsCappedAndSaysSo(t *testing.T) {
	f := billingHealthyFixture()
	var ids []string
	for i := range billingMaxAmbiguousCustomers + 2 {
		id := fmt.Sprintf("cus_many_%02d", i)
		ids = append(ids, id)
		f.web.customers["id:"+id] = webCustomerView{Customer: &webCustomer{ID: id}}
	}
	f.web.ambiguous = map[string][]string{"ada@example.com": ids}
	out, err := f.source(t).CheckSubscription(context.Background(), mcp.CheckSubscriptionInput{Email: "ada@example.com"})
	if err != nil {
		t.Fatal(err)
	}
	// The subject's own row customer is read by id too, so the reads are the cap plus one.
	if f.web.customerReads != billingMaxAmbiguousCustomers+1 {
		t.Fatalf("customer reads = %d, want the cap of %d plus the row's own customer", f.web.customerReads, billingMaxAmbiguousCustomers)
	}
	if got := sourceStatus(out.Sources, sourceStripe); got != "partial" {
		t.Fatalf("stripe source = %s, want partial", got)
	}
	if !hasNote(out.Notes, "2 more matched customer(s) were not read") {
		t.Fatalf("notes = %v, want the unread count named", out.Notes)
	}
}

// The user identity and the MCP identity are reported apart, because they are
// different callers; a month with no row for one is zero requests recorded.
func TestSubscriberUsageReportsUserAndMCPApart(t *testing.T) {
	now := time.Date(2026, 10, 23, 12, 0, 0, 0, time.UTC)
	october := time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)
	september := time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC)
	store := &billingStore{months: []shortsstore.APIUsageMonth{
		{Identifier: "user:uid-a", Month: october, Requests: 42},
		{Identifier: "oauth:uid-a", Month: october, Requests: 9},
		{Identifier: "oauth:uid-a", Month: september, Requests: 4},
		{Identifier: "some:other", Month: october, Requests: 1000},
	}}
	src := billingFixture{store: store, web: &billingWeb{}}.source(t)
	usage, sources := src.subscriberUsage(context.Background(), []string{"uid-a"}, now)

	if len(usage.API) != 3 || usage.API[0].Month != "2026-10" || usage.API[0].Requests != 42 || usage.API[1].Requests != 0 {
		t.Fatalf("api = %+v, want user:<uid> alone: 42 this month", usage.API)
	}
	if len(usage.MCP) != 3 || usage.MCP[0].Requests != 9 || usage.MCP[1].Month != "2026-09" || usage.MCP[1].Requests != 4 {
		t.Fatalf("mcp = %+v, want oauth:<uid> alone: 9 this month, 4 last", usage.MCP)
	}
	if got := sourceStatus(sources, sourceAPIUsage); got != "available" {
		t.Fatalf("api usage source = %s, want available", got)
	}
}

// amount is nullable on the wire: a subscription with no price reads as no amount,
// and the output omits it rather than reporting zero. A set price comes through.
func TestStripeAmountIsNullableAndOmittedWhenUnknown(t *testing.T) {
	periodEnd := billingClock().Add(20 * 24 * time.Hour)
	f := billingHealthyFixture()
	f.web.customers["id:cus_A"] = webCustomerView{
		Customer: &webCustomer{ID: "cus_A"},
		Subscriptions: []webSubscription{
			{ID: "sub_priced", Status: "active", Tier: "premium", Amount: new(int64(2900)), Currency: "aud", CurrentPeriodEnd: billingRFC(periodEnd)},
			{ID: "sub_unpriced", Status: "canceled", Tier: "premium", Amount: nil, CurrentPeriodEnd: billingRFC(periodEnd)},
		},
	}
	out, err := f.source(t).CheckSubscription(context.Background(), mcp.CheckSubscriptionInput{UserID: "uid-a"})
	if err != nil {
		t.Fatal(err)
	}
	var priced, unpriced *mcp.BillingStripeSubscription
	for i := range out.Stripe {
		for j := range out.Stripe[i].Subscriptions {
			s := &out.Stripe[i].Subscriptions[j]
			if s.Status == "active" {
				priced = s
			} else {
				unpriced = s
			}
		}
	}
	if priced == nil || priced.Amount == nil || *priced.Amount != 2900 {
		t.Fatalf("priced subscription = %+v, want its amount", priced)
	}
	if unpriced == nil || unpriced.Amount != nil {
		t.Fatalf("unpriced subscription = %+v, want no amount", unpriced)
	}
	raw, _ := json.Marshal(out.Stripe)
	if !strings.Contains(string(raw), `"amount":2900`) || strings.Count(string(raw), `"amount"`) != 1 {
		t.Fatalf("stripe JSON = %s, want amount present once, omitted for the unpriced subscription", raw)
	}
}

// The scenario the mismatch exists for: the account that really pays is "uid-a",
// but Stripe's live subscription on the customer was stamped onto a stale row keyed
// to "uid-stale". The real payer has no row, so the subject's own entitlement is
// no_subscription, and the stale row holds the customer. check_subscription must
// say so. Before this kind it was silent: the row existed, and it was entitled.
func TestCheckSubscriptionFindsASubscriptionRecordedForAnotherUser(t *testing.T) {
	f := billingHealthyFixture()
	f.store.rows[0].UserID = "uid-stale" // the row for the customer is keyed to a stale user
	out, err := f.source(t).CheckSubscription(context.Background(), mcp.CheckSubscriptionInput{Email: "ada@example.com"})
	if err != nil {
		t.Fatal(err)
	}
	if len(out.Drift) != 1 || out.Drift[0].Kind != kindSubscriptionUserMismatch {
		t.Fatalf("drift = %+v, want subscription_user_mismatch alone", out.Drift)
	}
	detail := out.Drift[0].Detail
	if !strings.Contains(detail, `"uid-a"`) || !strings.Contains(detail, `"uid-stale"`) {
		t.Fatalf("detail %q must name both user ids", detail)
	}
	if strings.Contains(detail, "@") || strings.Contains(detail, "cus_") || strings.Contains(detail, "sub_") {
		t.Fatalf("detail %q carries an email or a Stripe id", detail)
	}
	// The subject is the paying account. It has no row, so it has no entitlement;
	// the finding is what explains the paid subscription that the account cannot use.
	if out.Entitlement == nil || out.Entitlement.Entitled || out.Entitlement.Reason != "no_subscription" {
		t.Fatalf("entitlement = %+v, want the paying account to read no_subscription", out.Entitlement)
	}
}

// The same case through list_billing_exceptions: the sweep reports the stale row as
// the one to fix, with both user ids, and does not count it as paid without mirror.
func TestBillingExceptionsReportsASubscriptionRecordedForAnotherUser(t *testing.T) {
	f := billingHealthyFixture()
	f.store.rows[0].UserID = "uid-stale"
	// Stripe's live list carries the customer's live subscription, recorded for the
	// paying account. Without it the sweep would read the customer as having none.
	f.web.alive = webAliveList{Subscriptions: []webAliveSubscription{{
		CustomerID: "cus_A", SubscriptionID: "sub_A", Status: "active", Tier: "premium",
		Email: "ada@example.com", MetadataUserID: "uid-a",
	}}}
	src := f.source(t)
	out, err := src.BillingExceptions(context.Background(), mcp.BillingExceptionsInput{Limit: 25})
	if err != nil {
		t.Fatal(err)
	}
	if got := (*out.Counts)[kindSubscriptionUserMismatch]; got != 1 {
		t.Fatalf("counts = %v, want one subscription_user_mismatch", *out.Counts)
	}
	if got := (*out.Counts)[kindPaidWithoutMirror]; got != 0 {
		t.Fatalf("counts = %v: the customer has a row, so it is not paid without mirror", *out.Counts)
	}
	if len(out.Rows) != 1 || out.Rows[0].Kind != kindSubscriptionUserMismatch || out.Rows[0].UserID != "uid-stale" {
		t.Fatalf("rows = %+v, want the stale row reported", out.Rows)
	}
	detail := out.Rows[0].Detail
	if !strings.Contains(detail, `"uid-a"`) || !strings.Contains(detail, `"uid-stale"`) || strings.Contains(detail, "@") {
		t.Fatalf("detail %q must name both user ids and no email", detail)
	}
}

// Nothing is reported when the recorded user is the row's own user: the mismatch
// must not fire on a healthy customer, or it would drown the real findings.
func TestHealthyCustomerRaisesNoMismatch(t *testing.T) {
	out, err := billingHealthyFixture().source(t).CheckSubscription(context.Background(), mcp.CheckSubscriptionInput{Email: "ada@example.com"})
	if err != nil {
		t.Fatal(err)
	}
	for _, d := range out.Drift {
		if d.Kind == kindSubscriptionUserMismatch {
			t.Fatalf("drift = %+v: a customer whose subscription names its own row raised a mismatch", out.Drift)
		}
	}
	healthy := billingHealthyFixture()
	healthy.web.alive = webAliveList{Subscriptions: []webAliveSubscription{{
		CustomerID: "cus_A", SubscriptionID: "sub_A", Status: "active", Tier: "premium",
		Email: "ada@example.com", MetadataUserID: "uid-a",
	}}}
	exc, err := healthy.source(t).BillingExceptions(context.Background(), mcp.BillingExceptionsInput{Limit: 25})
	if err != nil {
		t.Fatal(err)
	}
	if got, ok := (*exc.Counts)[kindSubscriptionUserMismatch]; !ok || got != 0 {
		t.Fatalf("counts = %v: the kind must be checked and zero for a healthy customer", *exc.Counts)
	}
}
