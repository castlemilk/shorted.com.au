package mcp

// admin_billing.go: read-only admin tools that answer "does this subscriber's
// access match what they paid for?". users:read, like admin_people.go: this is
// personal data (emails, user ids, payment state).
//
// The verdicts are computed server-side by the same rule the product applies
// (services/shorts ResolveEntitlement). The tools report which sources they
// read, and a source that fails is named in sources, never shown as empty.
//
// Disclosure rules, beyond admin_people.go's:
//
//   - Stripe customer and subscription ids never appear. The one place a
//     customer is named is stripeDashboardUrl, which needs a Stripe login.
//   - No names, phone numbers, card or payment details, invoice or receipt
//     URLs. Amounts are subscription prices, not payment details.

import (
	"context"
	"fmt"
	"net/mail"
	"strings"
	"unicode"

	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

// AdminBillingReader is the billing-audit half of the admin operator. Inputs
// arrive validated: exactly one subscriber key, normalised, and limits bounded.
type AdminBillingReader interface {
	CheckSubscription(context.Context, CheckSubscriptionInput) (*CheckSubscriptionOutput, error)
	BillingExceptions(context.Context, BillingExceptionsInput) (*BillingExceptionsOutput, error)
}

// --- check_subscription ----------------------------------------------------

// CheckSubscriptionInput names ONE subscriber. The validated form carries
// exactly one of the two keys.
type CheckSubscriptionInput struct {
	Email  string `json:"email,omitempty" jsonschema:"The account's email address (case-insensitive). Give exactly one of email or userId."`
	UserID string `json:"userId,omitempty" jsonschema:"The Firebase user id. Give exactly one of email or userId."`
	// EmailAsTyped is the email as the administrator wrote it: trimmed, not
	// case-folded. Stripe is asked with it, and the web app retries in lower case
	// itself. It is never part of the tool's schema.
	EmailAsTyped string `json:"-"`
}

// CheckSubscriptionOutput sets what the subscriber is entitled to against what
// Stripe and the mirror say. Nullable sections are null when their source could
// not be read, and sources says which.
type CheckSubscriptionOutput struct {
	ObservedAt  string                 `json:"observedAt"`
	Email       string                 `json:"email,omitempty" jsonschema:"The email checked: the input, or the one the mirror holds for a user id."`
	UserID      string                 `json:"userId,omitempty" jsonschema:"The user id the entitlement and usage are for, when one is known."`
	Account     *BillingAccount        `json:"account" jsonschema:"The Firebase account with this email. Null when the accounts source could not be read."`
	Mirror      []BillingMirrorRow     `json:"mirror" jsonschema:"Every subscription-mirror row keyed by this user id or this email. More than one row for one person is a finding."`
	Entitlement *SubscriberEntitlement `json:"entitlement" jsonschema:"The verdict the product applies for this user id. Null when the mirror could not be read and the user has no internal grant."`
	Stripe      []BillingStripeView    `json:"stripe" jsonschema:"The live Stripe view for each customer found by the mirror rows' customer ids and by email. Empty when Stripe has no customer for them."`
	Drift       []BillingDriftFinding  `json:"drift" jsonschema:"Where the mirror and Stripe disagree, or the mirror is internally inconsistent. Empty means no disagreement only when the stripe source is available; check sources and notes."`
	Usage       *SubscriberUsage       `json:"usage" jsonschema:"Chat and API usage for the user ids. Null when no user id was known."`
	Sources     []JobSource            `json:"sources"`
	Notes       []string               `json:"notes"`
}

// BillingAccount is the Firebase account for the email.
type BillingAccount struct {
	Exists        bool     `json:"exists"`
	UserID        string   `json:"userId,omitempty"`
	Email         string   `json:"email,omitempty"`
	EmailVerified bool     `json:"emailVerified"`
	Disabled      bool     `json:"disabled"`
	Providers     []string `json:"providers"`
	CreatedAt     string   `json:"createdAt,omitempty"`
	LastSignInAt  string   `json:"lastSignInAt,omitempty"`
}

// BillingMirrorRow is one api_subscriptions row, as the Stripe webhook last
// recorded it.
type BillingMirrorRow struct {
	UserID                string  `json:"userId"`
	Email                 string  `json:"email"`
	Tier                  string  `json:"tier"`
	Status                *string `json:"status" jsonschema:"The row's status. Null when the row has none: a finding (null_status), never read as inactive."`
	CurrentPeriodStart    string  `json:"currentPeriodStart,omitempty"`
	CurrentPeriodEnd      string  `json:"currentPeriodEnd,omitempty"`
	CancelAtPeriodEnd     bool    `json:"cancelAtPeriodEnd"`
	CreatedAt             string  `json:"createdAt,omitempty"`
	UpdatedAt             string  `json:"updatedAt,omitempty"`
	HasStripeSubscription bool    `json:"hasStripeSubscription"`
	StripeDashboardURL    string  `json:"stripeDashboardUrl,omitempty" jsonschema:"The customer in the Stripe dashboard (requires a Stripe login). Absent when the row has no customer."`
	RecentlyUpdated       bool    `json:"recentlyUpdated,omitempty" jsonschema:"Updated in the last 15 minutes. Excluded from the drift check: a webhook may still be in flight."`
}

// SubscriberEntitlement is the verdict the product applies to one user id.
type SubscriberEntitlement struct {
	UserID   string `json:"userId,omitempty"`
	Entitled bool   `json:"entitled"`
	Tier     string `json:"tier"`
	Reason   string `json:"reason" jsonschema:"internal_grant | active | no_subscription | status_<status> | unpaid_tier | period_ended."`
	Source   string `json:"source" jsonschema:"internal (an operator grant) | stripe (the mirror row) | none."`
	Basis    string `json:"basis" jsonschema:"Which identity the verdict is for: the user id given, the Firebase account's uid, the newest mirror row when no account exists, or none."`
}

// BillingStripeView is one Stripe customer, read live through the web app.
type BillingStripeView struct {
	LookedUpBy         string                      `json:"lookedUpBy" jsonschema:"customer id (a mirror row's customer) or email."`
	StripeDashboardURL string                      `json:"stripeDashboardUrl"`
	CustomerCreated    string                      `json:"customerCreated,omitempty"`
	Subscriptions      []BillingStripeSubscription `json:"subscriptions"`
	LatestInvoice      *BillingStripeInvoice       `json:"latestInvoice"`
}

// BillingStripeSubscription is one Stripe subscription. Its id is never shown.
type BillingStripeSubscription struct {
	Status             string `json:"status"`
	Tier               string `json:"tier"`
	Interval           string `json:"interval,omitempty"`
	Amount             *int64 `json:"amount,omitempty" jsonschema:"The subscription price in minor units of its currency. Omitted when Stripe has no price for the subscription."`
	Currency           string `json:"currency,omitempty"`
	CurrentPeriodStart string `json:"currentPeriodStart,omitempty"`
	CurrentPeriodEnd   string `json:"currentPeriodEnd,omitempty"`
	CancelAtPeriodEnd  bool   `json:"cancelAtPeriodEnd"`
	Created            string `json:"created,omitempty"`
	MetadataUserID     string `json:"metadataUserId,omitempty" jsonschema:"The user id Stripe was told at checkout. Empty when it was not recorded."`
}

// BillingStripeInvoice is the customer's most recent invoice. No URLs.
type BillingStripeInvoice struct {
	Status     string `json:"status"`
	AmountPaid int64  `json:"amountPaid"`
	Currency   string `json:"currency,omitempty"`
	Created    string `json:"created,omitempty"`
	PaidAt     string `json:"paidAt,omitempty"`
}

// BillingDriftFinding is one disagreement between the mirror and Stripe, or one
// inconsistency inside the mirror.
type BillingDriftFinding struct {
	Kind   string `json:"kind" jsonschema:"paid_without_mirror | subscription_user_mismatch | unpaid_without_mirror | entitled_without_stripe | stale_subscription_id | status_mismatch | period_end_mismatch | cancel_mismatch | missing_period_end | null_status | duplicate_email | email_keyed_user_id. Severity order is the array order."`
	Detail string `json:"detail"`
}

// SubscriberUsage is what the chat and API tables say about the user ids.
type SubscriberUsage struct {
	Chat      *ChatUsageSummary  `json:"chat" jsonschema:"Null when the chat tables could not be read."`
	ChatSends *ChatSendsSummary  `json:"chatSends" jsonschema:"Chat sends by outcome from chat_usage_events. Null when that ledger is not in this database or could not be read; see sources."`
	API       []APIUsageMonthRow `json:"api" jsonschema:"Metered requests under user:<uid>, the API-token and signed-in browser identity, for the last three UTC months. Unlimited tiers are not metered, so a zero here is no metering, not no use. Null when the quota table could not be read."`
	MCP       []APIUsageMonthRow `json:"mcp" jsonschema:"Metered requests under oauth:<uid>, the MCP connector identity, for the last three UTC months. Unlimited tiers are not metered. Null when the quota table could not be read."`
}

// ChatUsageSummary is the user's chat history.
type ChatUsageSummary struct {
	Conversations          int    `json:"conversations"`
	UserMessagesLast30Days int    `json:"userMessagesLast30Days"`
	LastUserMessageAt      string `json:"lastUserMessageAt,omitempty"`
}

// ChatSendsSummary is the user's chat sends over the last 30 days.
type ChatSendsSummary struct {
	SendsByOutcome         map[string]int `json:"sendsByOutcome" jsonschema:"pending | ok | error | canceled | limited. limited sends were rejected before the model and are not counted against limits."`
	InputTokensLast30Days  int64          `json:"inputTokensLast30Days"`
	OutputTokensLast30Days int64          `json:"outputTokensLast30Days"`
}

// APIUsageMonthRow is one UTC month of metered API requests.
type APIUsageMonthRow struct {
	Month    string `json:"month" jsonschema:"YYYY-MM, UTC."`
	Requests int64  `json:"requests"`
}

// --- list_billing_exceptions ----------------------------------------------

// BillingExceptionsInput bounds the rows returned. Counts always cover every
// finding.
type BillingExceptionsInput struct {
	Limit int `json:"limit,omitempty" jsonschema:"Rows to return, 1-100, default 25. Counts always cover every finding."`
}

// BillingExceptionsOutput is the exception summary.
type BillingExceptionsOutput struct {
	ObservedAt string                  `json:"observedAt"`
	Counts     *BillingExceptionCounts `json:"counts" jsonschema:"Findings per kind over every subscriber checked. A kind absent here was not checked; notes says why. Null when the mirror could not be read."`
	Rows       []BillingExceptionRow   `json:"rows" jsonschema:"The first limit findings, most severe first."`
	Sources    []JobSource             `json:"sources"`
	Notes      []string                `json:"notes"`
}

// BillingExceptionCounts maps each finding kind to its count. It is a pointer
// in the output so that a refused call (which validates a zero output) and an
// unread mirror both serialise as null, not as a map the schema rejects.
type BillingExceptionCounts map[string]int

// BillingExceptionRow is one finding.
type BillingExceptionRow struct {
	Kind   string `json:"kind" jsonschema:"paid_without_mirror | subscription_user_mismatch | unpaid_without_mirror | entitled_without_stripe | stale_subscription_id | period_ended | unpaid_tier | past_due | null_status | missing_period_end | email_keyed_user_id | duplicate_email."`
	Email  string `json:"email,omitempty"`
	UserID string `json:"userId,omitempty"`
	Detail string `json:"detail"`
}

// --- validation -----------------------------------------------------------

// normaliseEmail lower-cases and checks a single plain address, as lookup_person
// does.
func normaliseEmail(raw string) (string, error) {
	email := strings.ToLower(strings.TrimSpace(raw))
	if addr, err := mail.ParseAddress(email); err != nil || addr.Address != email || len(email) > 254 {
		return "", fmt.Errorf("email must be a single plain address, e.g. name@example.com")
	}
	return email, nil
}

// normaliseUserID checks a Firebase user id: non-empty, bounded, no whitespace
// or control characters. Legacy email-keyed rows are looked up by email, not by
// id, so an "@" is not refused here.
func normaliseUserID(raw string) (string, error) {
	uid := strings.TrimSpace(raw)
	if uid == "" || len(uid) > 128 || strings.IndexFunc(uid, func(r rune) bool { return unicode.IsSpace(r) || unicode.IsControl(r) }) >= 0 {
		return "", fmt.Errorf("userId must be a single id of at most 128 characters")
	}
	return uid, nil
}

// --- tools -----------------------------------------------------------------

// billingTool registers a users:read tool that reads billing data. Like
// peopleTool, it records who read personal data.
func billingTool[I, O any](name, title, description string, handler func(context.Context, AdminBillingReader, I) (O, error)) AdminTool {
	return adminScopedReadTool(ScopeUsersRead, name, title, description, nil, func(ctx context.Context, op AdminOperator, req *sdk.CallToolRequest, in I) (O, error) {
		auditPeopleRead(req, name)
		return handler(ctx, op, in)
	})
}

func checkSubscriptionTool() AdminTool {
	return billingTool("check_subscription", "Check one subscriber's access against billing",
		"Does one subscriber's access match what they paid for? Give exactly one of email or userId. Returns the Firebase account, "+
			"every subscription-mirror row for the email or user id (more than one is a finding), the entitlement the product applies, "+
			"the live Stripe customer and subscriptions read through the web app, drift between the mirror and Stripe, and chat and API "+
			"usage. Drift compares each Stripe customer's best subscription with the one row that holds the customer, wherever that row is "+
			"keyed. api lists metered requests under the user id; mcp lists them under the OAuth identity. Unlimited tiers are not metered, "+
			"so their counts stay zero here. A source that fails is named in sources and its section is null, never empty. Rows updated in "+
			"the last 15 minutes are left out of the drift check because a webhook may still be in flight; notes says so.",
		func(ctx context.Context, r AdminBillingReader, in CheckSubscriptionInput) (*CheckSubscriptionOutput, error) {
			email, uid := strings.TrimSpace(in.Email), strings.TrimSpace(in.UserID)
			if (email == "") == (uid == "") {
				return nil, fmt.Errorf("give exactly one of email or userId")
			}
			typed := email
			var err error
			if email != "" {
				if email, err = normaliseEmail(email); err != nil {
					return nil, err
				}
			}
			if uid != "" {
				if uid, err = normaliseUserID(uid); err != nil {
					return nil, err
				}
			}
			return r.CheckSubscription(ctx, CheckSubscriptionInput{Email: email, EmailAsTyped: typed, UserID: uid})
		})
}

func billingExceptionsTool() AdminTool {
	return billingTool("list_billing_exceptions", "Billing exceptions across subscribers",
		"The billing exceptions across all subscribers, most severe first: a live Stripe subscription with no entitled mirror row "+
			"(money taken, no access), then access with no live Stripe subscription, then customers owed money with no row, then mirror rows "+
			"that are past due, past their period end, on an unpaid tier, with no status or no period end, keyed by email instead of a user id, "+
			"or sharing an email. Each Stripe customer's best live subscription is set against the one row that holds it. counts covers every "+
			"finding; rows are the first limit (default 25). Rows updated in the last 15 minutes are skipped. A kind absent from counts "+
			"was not checked, and notes says why.",
		func(ctx context.Context, r AdminBillingReader, in BillingExceptionsInput) (*BillingExceptionsOutput, error) {
			offset := 0
			if err := normalisePage(&in.Limit, &offset); err != nil {
				return nil, err
			}
			return r.BillingExceptions(ctx, in)
		})
}
