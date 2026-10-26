package shorts

// mcp_admin_billing.go: the read path behind the admin MCP server's
// check_subscription and list_billing_exceptions tools. The decisions live in
// mcp_admin_billing_drift.go; this file gathers the sources and turns them into
// the tools' outputs.
//
// A source that fails is named in sources and its section is left null, never
// filled with an empty value that would read as "none". Each failure is logged
// with its detail; the tool output carries only the generic reason.

import (
	"context"
	"errors"
	"strconv"
	"strings"
	"time"

	"github.com/castlemilk/shorted.com.au/services/pkg/log"
	"github.com/castlemilk/shorted.com.au/services/shorts/internal/mcp"
	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
)

const (
	sourceStripe          = "stripe"
	sourceStripeLive      = "stripe_live_subscriptions"
	sourceChatUsage       = "chat_usage"
	sourceChatUsageEvents = "chat_usage_events"
	sourceAPIUsage        = "api_usage_monthly"

	// billingExceptionRowsCap bounds the mirror read of the exception sweep.
	// Past it the counts are lower bounds, and the output says so.
	billingExceptionRowsCap = 5000
	// billingAPIMonths is how many UTC months of metered requests are reported.
	billingAPIMonths = 3
)

var (
	errBillingUnavailable = errors.New("the subscription mirror could not be read")
	errStripeUnavailable  = errors.New("the web app did not answer the billing read")
	// errNothingToLookUp is the state of a subject with no email and no Stripe
	// customer id: there is nothing to ask Stripe for.
	errNothingToLookUp = errors.New("nothing to look up: no email and no Stripe customer id")
)

// billingStoreFrom returns the billing reads when the people store is Postgres.
// They share its pool, so no second connection is opened.
func billingStoreFrom(people shortsstore.PeopleStore) shortsstore.BillingStore {
	b, _ := people.(shortsstore.BillingStore)
	return b
}

// CheckSubscription answers "does this subscriber's access match what they
// paid for?" for one email or one user id.
//
// It reads in phases, because each one can name a key the next needs: the mirror
// rows for the key given, then Stripe for the customers those rows and the email
// name, then the row that holds each customer Stripe found (under any email or uid),
// then usage, then the verdict and drift. A customer's row is the one drift compares
// with, so it must be found by customer, not only by the subject's email.
func (a *adminMCPSource) CheckSubscription(ctx context.Context, in mcp.CheckSubscriptionInput) (*mcp.CheckSubscriptionOutput, error) {
	now := time.Now()
	out := &mcp.CheckSubscriptionOutput{
		ObservedAt: now.UTC().Format(time.RFC3339),
		Mirror:     []mcp.BillingMirrorRow{},
		Stripe:     []mcp.BillingStripeView{},
		Drift:      []mcp.BillingDriftFinding{},
		Sources:    []mcp.JobSource{},
		Notes:      []string{},
	}
	uid, email := in.UserID, in.Email
	// Stripe is asked with the email as typed. A row-derived email keeps the case the
	// row holds, since that is what Stripe recorded.
	stripeEmail := in.EmailAsTyped

	// 1. The mirror, under the keys given. A user id alone learns its email from its
	// own row, and the account lookup is by email.
	queriedUID, queriedEmail := uid, email
	rows, truncated, mirrorErr := a.billingRows(ctx, uid, email)
	if mirrorErr == nil && email == "" && len(rows) > 0 {
		email = strings.ToLower(rows[0].UserEmail)
		stripeEmail = rows[0].UserEmail
	}
	if stripeEmail == "" {
		stripeEmail = email
	}

	// 2. The account by email. Its uid completes the key when only the email was given.
	account, accountErr := a.accountFor(ctx, email)
	if accountErr == nil && account != nil && uid == "" {
		uid = account.UID
	}
	// Re-read when the key grew, so every row for the email and for the uid is in view.
	if uid != queriedUID || email != queriedEmail {
		rows, truncated, mirrorErr = a.billingRows(ctx, uid, email)
	}
	if in.UserID != "" && accountErr == nil && account != nil && account.UID != in.UserID {
		out.Notes = append(out.Notes, "The Firebase account for this email has a different user id from the one given; the entitlement is for the one given.")
	}
	if truncated {
		out.Notes = append(out.Notes, "More than "+strconv.Itoa(shortsstore.BillingRowsPerSubject)+" mirror rows match; the list is cut and the drift check saw only what is listed.")
	}

	// 3. Stripe, for the customers the rows and the email name.
	read, stripeErr := a.stripeCustomerViews(ctx, stripeEmail, distinctCustomerIDs(rows))
	views := read.views
	if read.ambiguous {
		note := "The email matches " + strconv.Itoa(read.matched) + " Stripe customers. Each one read is compared with its row, but the Stripe answer is partial: the subject may hold more than one customer."
		if read.unread > 0 {
			note += " " + strconv.Itoa(read.unread) + " more matched customer(s) were not read (the cap is " + strconv.Itoa(billingMaxAmbiguousCustomers) + ")."
		}
		out.Notes = append(out.Notes, note)
	}

	// 4. The row that holds each customer Stripe found, however it is keyed. A
	// customer's row under another email or user id is the one drift compares with.
	if mirrorErr == nil && stripeErr == nil {
		if extra := customerIDsNotIn(views, rows); len(extra) > 0 {
			more, err := a.billingRowsByCustomers(ctx, extra)
			if err != nil {
				mirrorErr = errBillingUnavailable
			} else {
				rows = mergeBillingRows(rows, more)
			}
		}
	}

	// 5. Usage for every user id the rows hold.
	usage, usageSources := a.subscriberUsage(ctx, distinctUserIDs(uid, rows), now)

	// 6. The entitlement is for one user id: the one given, the Firebase account's,
	// or, with neither, the newest row the mirror holds for the email.
	entUID, basis := uid, "none"
	switch {
	case in.UserID != "":
		basis = "user id"
	case uid != "":
		basis = "firebase account"
	case len(rows) > 0:
		entUID = rows[0].UserID
		basis = "newest mirror row"
		if accountErr != nil {
			basis += " (account source unavailable)"
		} else {
			basis += " (no Firebase account for this email)"
		}
	}
	if mirrorErr == nil {
		out.Entitlement = entitlementOutput(entUID, billingVerdict(entUID, findBillingRow(rows, entUID), now), basis)
	} else {
		// The mirror is down, so the only verdict we can give without it is an
		// operator grant, which the product checks before the store.
		if _, granted := InternalTierFor(entUID); granted && entUID != "" {
			out.Entitlement = entitlementOutput(entUID, ResolveEntitlement(entUID, nil, now), basis)
		}
		if out.Entitlement == nil {
			out.Notes = append(out.Notes, "The subscription mirror could not be read: the entitlement is unknown unless the user has an operator grant.")
		}
	}

	// 7. Mirror rows and drift. Drift needs the whole mirror and Stripe; without
	// either it does not run, and the notes say so.
	stripeOK := stripeErr == nil || errors.Is(stripeErr, errNothingToLookUp)
	if mirrorErr == nil {
		for i := range rows {
			out.Mirror = append(out.Mirror, mirrorRowOutput(rows[i], now))
		}
		drift, skipped := billingDrift(now, rows, views, stripeOK)
		out.Drift = append(out.Drift, drift...)
		if len(skipped) > 0 {
			out.Notes = append(out.Notes, strconv.Itoa(len(skipped))+" mirror row(s) updated in the last "+strconv.Itoa(int(billingRecentWindow/time.Minute))+" minutes were left out of the drift check: a webhook may still be in flight.")
		}
		if !stripeOK {
			out.Notes = append(out.Notes, "Stripe was not read, so drift against Stripe was not checked; the mirror-only checks ran.")
		}
	} else {
		out.Notes = append(out.Notes, "The subscription mirror could not be read, so the drift check did not run.")
	}
	if len(views) > 1 {
		out.Notes = append(out.Notes, strconv.Itoa(len(views))+" Stripe customers match this subject; the mirror and Stripe may disagree about which one is theirs.")
	}
	for _, v := range views {
		out.Stripe = append(out.Stripe, v.output())
	}

	out.Email = email
	out.UserID = entUID
	if accountErr == nil {
		out.Account = accountOutput(account)
	}
	out.Usage = usage

	out.Sources = append(out.Sources, accountSource(accountErr), mirrorSource(mirrorErr, truncated), stripeSource(stripeErr, read))
	out.Sources = append(out.Sources, usageSources...)
	return out, nil
}

// BillingExceptions sweeps every subscriber for the exceptions the billing
// audit defines, most severe first.
func (a *adminMCPSource) BillingExceptions(ctx context.Context, in mcp.BillingExceptionsInput) (*mcp.BillingExceptionsOutput, error) {
	now := time.Now()
	out := &mcp.BillingExceptionsOutput{
		ObservedAt: now.UTC().Format(time.RFC3339),
		Rows:       []mcp.BillingExceptionRow{},
		Sources:    []mcp.JobSource{},
		Notes:      []string{},
	}
	if a.billing == nil {
		out.Sources = append(out.Sources, mcp.JobSource{Name: sourceSubscriptions, Status: "unavailable", Detail: "the admin billing reads are not wired to Postgres in this deployment"})
		out.Notes = append(out.Notes, "The mirror could not be read, so no exception can be reported.")
		return out, nil
	}
	rows, truncated, err := a.billing.BillingSubscriptionsAll(ctx, billingExceptionRowsCap)
	if err != nil {
		log.Warnf("admin list_billing_exceptions: mirror: %v", err)
		out.Sources = append(out.Sources, mcp.JobSource{Name: sourceSubscriptions, Status: "unavailable", Detail: "the Stripe webhook mirror in Postgres could not be read"})
		out.Notes = append(out.Notes, "The mirror could not be read, so no exception can be reported.")
		return out, nil
	}
	out.Sources = append(out.Sources, mcp.JobSource{Name: sourceSubscriptions, Status: "available", Detail: "api_subscriptions, as the Stripe webhook last recorded it"})

	input := exceptionInput{Now: now, Rows: rows}
	alive, aliveErr := a.aliveSubscriptions(ctx)
	switch {
	case aliveErr != nil:
		out.Sources = append(out.Sources, mcp.JobSource{Name: sourceStripeLive, Status: "unavailable", Detail: "live Stripe subscriptions could not be read through the web app"})
		out.Notes = append(out.Notes, "Live Stripe subscriptions could not be read, so paid_without_mirror and entitled_without_stripe were not checked.")
	default:
		input.Alive, input.AliveOK, input.AliveTruncated = alive.Subscriptions, true, alive.Truncated
		detail := "every live Stripe subscription, read through the web app"
		if alive.Truncated {
			detail += "; the list was cut at its limit"
			out.Notes = append(out.Notes, "The live Stripe list was cut at its limit: entitled_without_stripe was not checked, and paid_without_mirror covers only the subscriptions listed.")
		}
		out.Sources = append(out.Sources, mcp.JobSource{Name: sourceStripeLive, Status: "available", Detail: detail})
	}

	res := billingExceptions(input)
	counts := mcp.BillingExceptionCounts(res.Counts)
	out.Counts = &counts
	if truncated {
		out.Notes = append(out.Notes, "The mirror holds more than "+strconv.Itoa(billingExceptionRowsCap)+" rows; the counts are lower bounds.")
	}
	if res.SkippedRecent > 0 {
		out.Notes = append(out.Notes, strconv.Itoa(res.SkippedRecent)+" row(s) updated in the last "+strconv.Itoa(int(billingRecentWindow/time.Minute))+" minutes were skipped: a webhook may still be in flight.")
	}

	limit := in.Limit
	if limit <= 0 {
		limit = 25
	}
	shown := res.Findings
	if len(shown) > limit {
		shown = shown[:limit]
		out.Notes = append(out.Notes, "Rows show the first "+strconv.Itoa(limit)+" of "+strconv.Itoa(len(res.Findings))+" findings, most severe first; counts cover them all.")
	}
	out.Rows = append(out.Rows, shown...)
	return out, nil
}

// --- the sources -------------------------------------------------------------

// billingRows reads the mirror rows for a user id, an email, or both.
func (a *adminMCPSource) billingRows(ctx context.Context, uid, email string) ([]shortsstore.BillingSubscription, bool, error) {
	if a.billing == nil {
		return nil, false, errBillingUnavailable
	}
	rows, truncated, err := a.billing.BillingSubscriptionsFor(ctx, uid, email)
	if err != nil {
		log.Warnf("admin billing: mirror rows: %v", err)
		return nil, false, errBillingUnavailable
	}
	return rows, truncated, nil
}

// billingRowsByCustomers reads the rows that hold the given Stripe customers.
func (a *adminMCPSource) billingRowsByCustomers(ctx context.Context, customerIDs []string) ([]shortsstore.BillingSubscription, error) {
	if a.billing == nil {
		return nil, errBillingUnavailable
	}
	rows, err := a.billing.BillingSubscriptionsByCustomers(ctx, customerIDs)
	if err != nil {
		log.Warnf("admin billing: mirror rows by customer: %v", err)
		return nil, errBillingUnavailable
	}
	return rows, nil
}

// customerIDsNotIn returns the Stripe customers the views hold that no row in rows
// already names, in view order.
func customerIDsNotIn(views []stripeCustomerView, rows []shortsstore.BillingSubscription) []string {
	known := map[string]bool{}
	for _, r := range rows {
		if r.StripeCustomerID != "" {
			known[r.StripeCustomerID] = true
		}
	}
	var out []string
	for _, v := range views {
		if v.customerID != "" && !known[v.customerID] {
			known[v.customerID] = true
			out = append(out, v.customerID)
		}
	}
	return out
}

// mergeBillingRows adds the rows of more that rows does not already hold, by user id.
func mergeBillingRows(rows, more []shortsstore.BillingSubscription) []shortsstore.BillingSubscription {
	seen := map[string]bool{}
	for _, r := range rows {
		seen[r.UserID] = true
	}
	for _, r := range more {
		if !seen[r.UserID] {
			seen[r.UserID] = true
			rows = append(rows, r)
		}
	}
	return rows
}

// accountFor looks up the Firebase account by email. A nil account with no
// error means there is none.
func (a *adminMCPSource) accountFor(ctx context.Context, email string) (*firebaseUser, error) {
	if email == "" {
		return nil, errNothingToLookUp
	}
	if a.users == nil {
		return nil, errUsersUnavailable
	}
	u, err := a.users.Lookup(ctx, email)
	if err != nil {
		log.Warnf("admin billing: account: %v", err)
		return nil, errUsersUnavailable
	}
	return u, nil
}

// billingMaxAmbiguousCustomers bounds how many of the customers an ambiguous email
// matches are read. Past it the answer stays partial, and the note says how many
// were left out.
const billingMaxAmbiguousCustomers = 10

// stripeRead is what the Stripe side returned for one subject.
type stripeRead struct {
	views []stripeCustomerView
	// ambiguous is set when the email named more than one Stripe customer. The
	// answer is then partial: the subject may hold more than one customer.
	ambiguous bool
	// matched is how many customers the email named, when it was ambiguous.
	matched int
	// unread is how many of those were beyond the cap and were not read.
	unread int
}

// stripeCustomerViews reads every Stripe customer the subject matches: each distinct
// customer id on its mirror rows, and the customer or customers the email names. An
// email that names several customers is answered by the web with no customer and
// the ids it matched; each id is then read in turn, up to the cap. One failed read
// fails the whole set, so no Stripe-dependent check runs on partial data.
//
// email is what Stripe is asked with: the admin's email as typed, which the web app
// retries in lower case itself.
func (a *adminMCPSource) stripeCustomerViews(ctx context.Context, email string, customerIDs []string) (stripeRead, error) {
	var read stripeRead
	if a.web == nil {
		return read, errWebUnavailable
	}
	if email == "" && len(customerIDs) == 0 {
		return read, errNothingToLookUp
	}
	seen := map[string]bool{}
	add := func(v *webCustomerView, lookedUpBy string) {
		if v == nil || v.Customer == nil || seen[v.Customer.ID] {
			return
		}
		seen[v.Customer.ID] = true
		read.views = append(read.views, stripeCustomerView{
			customerID: v.Customer.ID, lookedUpBy: lookedUpBy, created: v.Customer.Created,
			subs: v.Subscriptions, invoice: v.LatestInvoice,
		})
	}
	for _, id := range customerIDs {
		v, err := a.web.customer(ctx, webBillingRequest{Action: "customer", CustomerID: id})
		if err != nil {
			log.Warnf("admin billing: stripe by customer: %v", err)
			return read, errStripeUnavailable
		}
		add(v, "customer id")
	}
	if email != "" {
		v, err := a.web.customer(ctx, webBillingRequest{Action: "customer", Email: email})
		if err != nil {
			log.Warnf("admin billing: stripe by email: %v", err)
			return read, errStripeUnavailable
		}
		if !v.Ambiguous {
			add(v, "email")
			return read, nil
		}
		read.ambiguous = true
		read.matched = len(v.CustomerIDs)
		ids := v.CustomerIDs
		if len(ids) > billingMaxAmbiguousCustomers {
			read.unread = len(ids) - billingMaxAmbiguousCustomers
			ids = ids[:billingMaxAmbiguousCustomers]
		}
		for _, id := range ids {
			if seen[id] {
				continue
			}
			cv, err := a.web.customer(ctx, webBillingRequest{Action: "customer", CustomerID: id})
			if err != nil {
				log.Warnf("admin billing: stripe by ambiguous customer: %v", err)
				return read, errStripeUnavailable
			}
			add(cv, "email (matches several customers)")
		}
	}
	return read, nil
}

// aliveSubscriptions reads every live Stripe subscription through the web app.
func (a *adminMCPSource) aliveSubscriptions(ctx context.Context) (*webAliveList, error) {
	if a.web == nil {
		return nil, errWebUnavailable
	}
	list, err := a.web.aliveSubscriptions(ctx)
	if err != nil {
		log.Warnf("admin billing: live subscriptions: %v", err)
		return nil, errStripeUnavailable
	}
	return list, nil
}

// subscriberUsage reads the chat and API usage of the user ids. Each part is
// its own source, so a missing ledger does not hide the rest.
func (a *adminMCPSource) subscriberUsage(ctx context.Context, ids []string, now time.Time) (*mcp.SubscriberUsage, []mcp.JobSource) {
	usage := &mcp.SubscriberUsage{}
	if len(ids) == 0 {
		return nil, []mcp.JobSource{
			{Name: sourceChatUsage, Status: "unavailable", Detail: "no user id is known for this subscriber"},
			{Name: sourceChatUsageEvents, Status: "unavailable", Detail: "no user id is known for this subscriber"},
			{Name: sourceAPIUsage, Status: "unavailable", Detail: "no user id is known for this subscriber"},
		}
	}
	if a.billing == nil {
		const detail = "the admin billing reads are not wired to Postgres in this deployment"
		return usage, []mcp.JobSource{
			{Name: sourceChatUsage, Status: "unavailable", Detail: detail},
			{Name: sourceChatUsageEvents, Status: "unavailable", Detail: detail},
			{Name: sourceAPIUsage, Status: "unavailable", Detail: detail},
		}
	}
	var sources []mcp.JobSource

	chat, err := a.billing.ChatUsage(ctx, ids)
	switch {
	case errors.Is(err, shortsstore.ErrRelationMissing):
		sources = append(sources, mcp.JobSource{Name: sourceChatUsage, Status: "unavailable", Detail: "the chat tables are not in this database"})
	case err != nil:
		log.Warnf("admin billing: chat usage: %v", err)
		sources = append(sources, mcp.JobSource{Name: sourceChatUsage, Status: "unavailable", Detail: "the chat history could not be read"})
	default:
		usage.Chat = &mcp.ChatUsageSummary{Conversations: chat.Conversations, UserMessagesLast30Days: chat.UserMessagesLast30Days, LastUserMessageAt: rfc3339(chat.LastUserMessageAt)}
		sources = append(sources, mcp.JobSource{Name: sourceChatUsage, Status: "available", Detail: "chat_conversations and chat_messages; the user's own messages count, assistant replies do not"})
	}

	events, err := a.billing.ChatUsageEvents(ctx, ids)
	switch {
	case errors.Is(err, shortsstore.ErrRelationMissing):
		sources = append(sources, mcp.JobSource{Name: sourceChatUsageEvents, Status: "unavailable", Detail: "not in this database: the chat send ledger (migration 000145) is not applied here, so sends are unknown, not zero"})
	case err != nil:
		log.Warnf("admin billing: chat sends: %v", err)
		sources = append(sources, mcp.JobSource{Name: sourceChatUsageEvents, Status: "unavailable", Detail: "the chat send ledger could not be read"})
	default:
		usage.ChatSends = &mcp.ChatSendsSummary{SendsByOutcome: events.SendsByOutcome, InputTokensLast30Days: events.InputTokensLast30, OutputTokensLast30Days: events.OutputTokensLast30}
		sources = append(sources, mcp.JobSource{Name: sourceChatUsageEvents, Status: "available", Detail: "chat_usage_events: sends in the last 30 days by outcome; limited sends were rejected before the model"})
	}

	months, err := a.billing.APIUsageByMonth(ctx, ids)
	if err != nil {
		log.Warnf("admin billing: api usage: %v", err)
		sources = append(sources, mcp.JobSource{Name: sourceAPIUsage, Status: "unavailable", Detail: "the metered request counts could not be read"})
	} else {
		// user:<uid> is the API-token and signed-in browser identity; oauth:<uid> is the
		// MCP connector's. They are reported apart, because they are different callers.
		var user, mcp_ []shortsstore.APIUsageMonth
		for _, m := range months {
			switch {
			case strings.HasPrefix(m.Identifier, "user:"):
				user = append(user, m)
			case strings.HasPrefix(m.Identifier, "oauth:"):
				mcp_ = append(mcp_, m)
			}
		}
		usage.API = apiUsageMonths(now, user)
		usage.MCP = apiUsageMonths(now, mcp_)
		sources = append(sources, mcp.JobSource{Name: sourceAPIUsage, Status: "available", Detail: "metered requests per UTC month from the rate limiter's count, for user:<uid> (API and signed-in browser calls) and oauth:<uid> (MCP); not a billing ledger, and may lag a few minutes"})
	}
	return usage, sources
}

// apiUsageMonths reports the current and the two previous UTC months, newest
// first, summing the user's identifiers. A month with no row is zero requests
// recorded, which is a real reading (the source was read).
func apiUsageMonths(now time.Time, rows []shortsstore.APIUsageMonth) []mcp.APIUsageMonthRow {
	base := time.Date(now.UTC().Year(), now.UTC().Month(), 1, 0, 0, 0, 0, time.UTC)
	out := make([]mcp.APIUsageMonthRow, 0, billingAPIMonths)
	for back := range billingAPIMonths {
		month := base.AddDate(0, -back, 0)
		var n int64
		for _, r := range rows {
			if r.Month.Year() == month.Year() && r.Month.Month() == month.Month() {
				n += r.Requests
			}
		}
		out = append(out, mcp.APIUsageMonthRow{Month: month.Format("2006-01"), Requests: n})
	}
	return out
}

// --- source status lines ----------------------------------------------------

func accountSource(err error) mcp.JobSource {
	switch {
	case errors.Is(err, errNothingToLookUp):
		return mcp.JobSource{Name: sourceAccounts, Status: "unavailable", Detail: "no email is known for this user id, so the account cannot be looked up by email"}
	case err != nil:
		return mcp.JobSource{Name: sourceAccounts, Status: "unavailable", Detail: "Firebase Auth could not be read through the web app"}
	}
	return mcp.JobSource{Name: sourceAccounts, Status: "available", Detail: "Firebase Auth, read through the web app, by email"}
}

func mirrorSource(err error, truncated bool) mcp.JobSource {
	if err != nil {
		return mcp.JobSource{Name: sourceSubscriptions, Status: "unavailable", Detail: "the Stripe webhook mirror in Postgres could not be read"}
	}
	detail := "api_subscriptions, as the Stripe webhook last recorded it"
	if truncated {
		detail += "; capped at " + strconv.Itoa(shortsstore.BillingRowsPerSubject) + " rows"
	}
	return mcp.JobSource{Name: sourceSubscriptions, Status: "available", Detail: detail}
}

func stripeSource(err error, read stripeRead) mcp.JobSource {
	switch {
	case errors.Is(err, errWebUnavailable):
		return mcp.JobSource{Name: sourceStripe, Status: "unavailable", Detail: errWebUnavailable.Error()}
	case errors.Is(err, errNothingToLookUp):
		return mcp.JobSource{Name: sourceStripe, Status: "unavailable", Detail: "no email or Stripe customer id to look up"}
	case err != nil:
		return mcp.JobSource{Name: sourceStripe, Status: "unavailable", Detail: "the web app did not answer the billing read"}
	}
	if read.ambiguous {
		return mcp.JobSource{Name: sourceStripe, Status: "partial", Detail: "the email matches " + strconv.Itoa(read.matched) + " Stripe customers; " + strconv.Itoa(len(read.views)) + " were read, so the answer covers what is listed and may not cover every customer of this subject"}
	}
	return mcp.JobSource{Name: sourceStripe, Status: "available", Detail: "the live customer and subscriptions, read through the web app; " + strconv.Itoa(len(read.views)) + " customer(s) match"}
}

// --- output shaping ----------------------------------------------------------

func entitlementOutput(uid string, e Entitlement, basis string) *mcp.SubscriberEntitlement {
	return &mcp.SubscriberEntitlement{UserID: uid, Entitled: e.Entitled, Tier: e.Tier, Reason: e.Reason, Source: e.Source, Basis: basis}
}

func accountOutput(u *firebaseUser) *mcp.BillingAccount {
	if u == nil {
		return &mcp.BillingAccount{Exists: false, Providers: []string{}}
	}
	providers := u.Providers
	if providers == nil {
		providers = []string{}
	}
	return &mcp.BillingAccount{
		Exists: true, UserID: u.UID, Email: u.Email, EmailVerified: u.EmailVerified, Disabled: u.Disabled,
		Providers: providers, CreatedAt: u.CreatedAt, LastSignInAt: u.LastSignInAt,
	}
}

func mirrorRowOutput(r shortsstore.BillingSubscription, now time.Time) mcp.BillingMirrorRow {
	var status *string
	if !r.StatusNull {
		status = &r.Status
	}
	return mcp.BillingMirrorRow{
		UserID:                r.UserID,
		Email:                 r.UserEmail,
		Tier:                  r.Tier,
		Status:                status,
		CurrentPeriodStart:    periodOutput(r.CurrentPeriodStart),
		CurrentPeriodEnd:      periodOutput(r.CurrentPeriodEnd),
		CancelAtPeriodEnd:     r.CancelAtPeriodEnd,
		CreatedAt:             rfc3339(r.CreatedAt),
		UpdatedAt:             rfc3339(r.UpdatedAt),
		HasStripeSubscription: r.StripeSubscriptionID != "",
		StripeDashboardURL:    stripeCustomerURL(r.StripeCustomerID),
		RecentlyUpdated:       isRecentlyUpdated(r, now),
	}
}

func (v stripeCustomerView) output() mcp.BillingStripeView {
	out := mcp.BillingStripeView{
		LookedUpBy:         v.lookedUpBy,
		StripeDashboardURL: stripeCustomerURL(v.customerID),
		CustomerCreated:    derefString(v.created),
		Subscriptions:      []mcp.BillingStripeSubscription{},
	}
	for _, s := range v.subs {
		out.Subscriptions = append(out.Subscriptions, mcp.BillingStripeSubscription{
			Status: s.Status, Tier: s.Tier, Interval: s.Interval, Amount: s.Amount, Currency: s.Currency,
			CurrentPeriodStart: derefString(s.CurrentPeriodStart), CurrentPeriodEnd: derefString(s.CurrentPeriodEnd),
			CancelAtPeriodEnd: s.CancelAtPeriodEnd, Created: derefString(s.Created), MetadataUserID: s.MetadataUserID,
		})
	}
	if v.invoice != nil {
		out.LatestInvoice = &mcp.BillingStripeInvoice{
			Status: v.invoice.Status, AmountPaid: v.invoice.AmountPaid, Currency: v.invoice.Currency,
			Created: derefString(v.invoice.Created), PaidAt: derefString(v.invoice.PaidAt),
		}
	}
	return out
}

// stripeCustomerURL is the one place a Stripe customer id is printed. The
// dashboard needs a Stripe login, so the link discloses nothing to a reader
// without one.
func stripeCustomerURL(customerID string) string {
	if customerID == "" {
		return ""
	}
	return "https://dashboard.stripe.com/customers/" + customerID
}

// periodOutput renders a stored period bound as RFC3339, or as stored when it
// does not parse, so an unreadable value is shown rather than dropped.
func periodOutput(text *string) string {
	if text == nil || *text == "" {
		return ""
	}
	if t, ok := parseStoreTimestamp(*text); ok {
		return t.UTC().Format(time.RFC3339)
	}
	return *text
}

func derefString(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

func findBillingRow(rows []shortsstore.BillingSubscription, uid string) *shortsstore.BillingSubscription {
	for i := range rows {
		if rows[i].UserID == uid {
			return &rows[i]
		}
	}
	return nil
}

// distinctCustomerIDs returns the non-empty Stripe customer ids the rows name,
// in row order.
func distinctCustomerIDs(rows []shortsstore.BillingSubscription) []string {
	seen := map[string]bool{}
	var out []string
	for _, r := range rows {
		if r.StripeCustomerID != "" && !seen[r.StripeCustomerID] {
			seen[r.StripeCustomerID] = true
			out = append(out, r.StripeCustomerID)
		}
	}
	return out
}

// distinctUserIDs returns the subject's user id followed by every user id the
// rows hold, once each.
func distinctUserIDs(uid string, rows []shortsstore.BillingSubscription) []string {
	seen := map[string]bool{}
	var out []string
	add := func(id string) {
		if id != "" && !seen[id] {
			seen[id] = true
			out = append(out, id)
		}
	}
	add(uid)
	for _, r := range rows {
		add(r.UserID)
	}
	return out
}
