package mcp

// admin_people.go: read-only admin tools over PERSONAL DATA — who has signed
// up, who pays, and who is on the mailing list.
//
// Where each answer comes from (none of it is duplicated into a new table):
//
//   - Signed-up accounts are Firebase Auth users. The API cannot list them
//     itself (Firebase Admin needs a project-level IAM grant the deploy account
//     cannot make; see admin_check.go), so the web app answers, behind
//     INTERNAL_SERVICE_SECRET, at /api/internal/admin-users.
//   - Paying users are api_subscriptions, the mirror the Stripe webhook keeps.
//   - The mailing list is the subscriptions table (RegisterEmail, broadcasts).
//
// Rules every tool here follows:
//
//   - Its own scope, users:read. jobs:read (monitoring) never reaches this data.
//   - The fewest fields that answer "who and what state": an email, a user id,
//     dates, plan and status. No names, photos, phone numbers, Stripe ids,
//     unsubscribe ids or tokens.
//   - Every call is logged with the caller's user id and the tool name (never
//     the arguments, which can be an email), so access to the data is auditable.
//   - Paginated with limit/offset and a nextOffset, like list_enrichment_jobs.

import (
	"context"
	"fmt"
	"net/mail"
	"slices"
	"strings"

	sdk "github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/castlemilk/shorted.com.au/services/pkg/log"
)

// AdminPeopleReader is the personal-data half of the admin operator. Inputs
// arrive already validated and normalised (limits defaulted and bounded,
// statuses from a closed set, emails trimmed and lower-cased).
type AdminPeopleReader interface {
	PeopleOverview(context.Context) (*PeopleOverviewOutput, error)
	ListUsers(context.Context, ListUsersInput) (*ListUsersOutput, error)
	ListPayingUsers(context.Context, ListPayingUsersInput) (*ListPayingUsersOutput, error)
	ListMailingList(context.Context, ListMailingListInput) (*ListMailingListOutput, error)
	LookupPerson(context.Context, LookupPersonInput) (*LookupPersonOutput, error)
}

// --- shapes ----------------------------------------------------------------

// UserCounts summarises Firebase accounts.
type UserCounts struct {
	Total              int            `json:"total"`
	EmailVerified      int            `json:"emailVerified"`
	Disabled           int            `json:"disabled"`
	SignedUpLast7Days  int            `json:"signedUpLast7Days"`
	SignedUpLast30Days int            `json:"signedUpLast30Days"`
	SignedInLast30Days int            `json:"signedInLast30Days"`
	ByProvider         map[string]int `json:"byProvider" jsonschema:"Accounts per sign-in provider (google.com, password, ...). An account with two providers counts under both."`
	Truncated          bool           `json:"truncated,omitempty" jsonschema:"True when there were more accounts than the scan reads; counts are then lower bounds."`
}

// PayingCounts summarises api_subscriptions.
type PayingCounts struct {
	Paying                int            `json:"paying" jsonschema:"Subscriptions in status active or trialing."`
	ByStatus              map[string]int `json:"byStatus"`
	PayingByTier          map[string]int `json:"payingByTier"`
	CancellingAtPeriodEnd int            `json:"cancellingAtPeriodEnd" jsonschema:"Paying subscriptions set to end at the close of the current period."`
	NewLast30Days         int            `json:"newLast30Days" jsonschema:"Subscription rows created in the last 30 days, any status."`
}

// MailingListCounts summarises the mailing list.
type MailingListCounts struct {
	Subscribed             int `json:"subscribed"`
	Unsubscribed           int `json:"unsubscribed"`
	JoinedLast7Days        int `json:"joinedLast7Days"`
	JoinedLast30Days       int `json:"joinedLast30Days"`
	UnsubscribedLast30Days int `json:"unsubscribedLast30Days"`
}

// PeopleOverviewOutput is the one-call summary. A source that could not be read
// is nil and named in sources/warnings, never reported as zero.
type PeopleOverviewOutput struct {
	ObservedAt  string             `json:"observedAt"`
	Users       *UserCounts        `json:"users,omitempty"`
	Paying      *PayingCounts      `json:"paying,omitempty"`
	MailingList *MailingListCounts `json:"mailingList,omitempty"`
	Sources     []JobSource        `json:"sources"`
	Warnings    []string           `json:"warnings"`
}

// UserRow is one signed-up account.
type UserRow struct {
	UserID        string   `json:"userId"`
	Email         string   `json:"email,omitempty"`
	EmailVerified bool     `json:"emailVerified"`
	Disabled      bool     `json:"disabled,omitempty"`
	Providers     []string `json:"providers"`
	CreatedAt     string   `json:"createdAt,omitempty"`
	LastSignInAt  string   `json:"lastSignInAt,omitempty"`
	Plan          string   `json:"plan,omitempty" jsonschema:"Subscription tier and status, e.g. premium (active); empty for a free account. Omitted when subscriptions could not be read."`
	OnMailingList *bool    `json:"onMailingList,omitempty" jsonschema:"Whether the account's email is subscribed to the mailing list. Omitted when the list could not be read."`
}

// PayingUserRow is one api_subscriptions row. Entitled and EntitlementReason
// are the verdict the product applies to the row (ResolveEntitlement), so a
// paying row that grants nothing reads as such rather than as paying.
type PayingUserRow struct {
	UserID            string `json:"userId"`
	Email             string `json:"email"`
	Tier              string `json:"tier"`
	Status            string `json:"status"`
	CurrentPeriodEnd  string `json:"currentPeriodEnd,omitempty"`
	CancelAtPeriodEnd bool   `json:"cancelAtPeriodEnd,omitempty"`
	CreatedAt         string `json:"createdAt,omitempty"`
	Entitled          bool   `json:"entitled" jsonschema:"Whether the product grants this row paid features right now."`
	EntitlementReason string `json:"entitlementReason" jsonschema:"ResolveEntitlement's reason: active | period_ended | unpaid_tier | status_<status> | internal_grant | no_subscription."`
}

// MailingListRow is one mailing list address.
type MailingListRow struct {
	Email          string `json:"email"`
	SubscribedAt   string `json:"subscribedAt,omitempty"`
	UnsubscribedAt string `json:"unsubscribedAt,omitempty"`
}

type ListUsersInput struct {
	Query  string `json:"query,omitempty" jsonschema:"Optional case-insensitive substring of the email, e.g. a domain."`
	Sort   string `json:"sort,omitempty" jsonschema:"newest (default, by sign-up date) or last_sign_in."`
	Limit  int    `json:"limit,omitempty" jsonschema:"Page size 1-100, default 25."`
	Offset int    `json:"offset,omitempty" jsonschema:"Zero-based offset; pass nextOffset from the previous page."`
}
type ListUsersOutput struct {
	Users      []UserRow `json:"users"`
	Total      int       `json:"total" jsonschema:"Accounts matching the query."`
	NextOffset *int      `json:"nextOffset,omitempty"`
	Truncated  bool      `json:"truncated,omitempty" jsonschema:"True when there were more accounts than the scan reads."`
	Warnings   []string  `json:"warnings,omitempty"`
}

type ListPayingUsersInput struct {
	Status string `json:"status,omitempty" jsonschema:"paying (default: active or trialing), active, trialing, past_due, unpaid, canceled, inactive, or all."`
	Limit  int    `json:"limit,omitempty" jsonschema:"Page size 1-100, default 25."`
	Offset int    `json:"offset,omitempty"`
}
type ListPayingUsersOutput struct {
	Subscriptions []PayingUserRow `json:"subscriptions"`
	Total         int             `json:"total"`
	NextOffset    *int            `json:"nextOffset,omitempty"`
}

type ListMailingListInput struct {
	Status string `json:"status,omitempty" jsonschema:"subscribed (default), unsubscribed or all."`
	Query  string `json:"query,omitempty" jsonschema:"Optional case-insensitive substring of the email."`
	Limit  int    `json:"limit,omitempty" jsonschema:"Page size 1-100, default 25."`
	Offset int    `json:"offset,omitempty"`
}
type ListMailingListOutput struct {
	Subscribers []MailingListRow `json:"subscribers"`
	Total       int              `json:"total"`
	NextOffset  *int             `json:"nextOffset,omitempty"`
}

type LookupPersonInput struct {
	Email string `json:"email" jsonschema:"The exact email address to look up (case-insensitive)."`
}
type LookupPersonOutput struct {
	Email        string          `json:"email"`
	Account      *UserRow        `json:"account,omitempty" jsonschema:"The signed-up account with this email; absent when there is none."`
	Subscription *PayingUserRow  `json:"subscription,omitempty" jsonschema:"The subscription row with this email; absent when there is none."`
	MailingList  *MailingListRow `json:"mailingList,omitempty" jsonschema:"The mailing list entry; absent when the address never joined."`
	Warnings     []string        `json:"warnings,omitempty" jsonschema:"Sources that could not be read; an absent field is then unknown, not no."`
}

// --- validation ----------------------------------------------------------------

const (
	peopleDefaultLimit = 25
	peopleMaxLimit     = 100
	peopleMaxOffset    = 1_000_000
	peopleMaxQuery     = 200
)

func normalisePage(limit, offset *int) error {
	if *limit == 0 {
		*limit = peopleDefaultLimit
	}
	if *limit < 1 || *limit > peopleMaxLimit {
		return fmt.Errorf("limit must be 1-%d", peopleMaxLimit)
	}
	if *offset < 0 || *offset > peopleMaxOffset {
		return fmt.Errorf("offset must be 0-%d", peopleMaxOffset)
	}
	return nil
}

func normaliseQuery(q *string) error {
	*q = strings.ToLower(strings.TrimSpace(*q))
	if len(*q) > peopleMaxQuery {
		return fmt.Errorf("query must be at most %d bytes", peopleMaxQuery)
	}
	return nil
}

// PayingStatuses is the closed set list_paying_users accepts.
var PayingStatuses = []string{"paying", "active", "trialing", "past_due", "unpaid", "canceled", "inactive", "all"}

// NextOffset returns the offset of the following page, or nil on the last one.
func NextOffset(offset, rows, total int) *int {
	next := offset + rows
	if rows == 0 || next >= total {
		return nil
	}
	return &next
}

// auditPeopleRead records who read personal data, and through which tool. The
// arguments are deliberately left out: they can be an email address.
func auditPeopleRead(req *sdk.CallToolRequest, tool string) {
	log.Infof("admin personal-data read: tool=%s actor=%s", tool, adminActor(req))
}

func peopleTool[I, O any](name, title, description string, handler func(context.Context, AdminPeopleReader, I) (O, error)) AdminTool {
	return adminScopedReadTool(ScopeUsersRead, name, title, description, nil, func(ctx context.Context, op AdminOperator, req *sdk.CallToolRequest, in I) (O, error) {
		auditPeopleRead(req, name)
		return handler(ctx, op, in)
	})
}

// --- tools ---------------------------------------------------------------------

func peopleOverviewTool() AdminTool {
	return peopleTool("people_overview", "Users, paying users and mailing list",
		"Counts of signed-up accounts (total, verified, new in the last 7 and 30 days, signed in within 30 days, by sign-in provider), "+
			"paying subscriptions (active or trialing, by tier and status, cancelling at period end, new in 30 days) and the mailing list "+
			"(subscribed, unsubscribed, joined and left recently). Start here; use list_users, list_paying_users, list_mailing_list or "+
			"lookup_person for individuals. A source that could not be read is omitted and named in warnings, never shown as zero.",
		func(ctx context.Context, r AdminPeopleReader, _ struct{}) (*PeopleOverviewOutput, error) {
			return r.PeopleOverview(ctx)
		})
}

func listUsersTool() AdminTool {
	return peopleTool("list_users", "Signed-up users",
		"Page through signed-up Shorted accounts (Firebase), newest first by default: user id, email, verified, sign-in providers, "+
			"sign-up and last sign-in dates, current plan and whether the email is on the mailing list. Filter with query (an email substring, "+
			"e.g. a domain). Follow nextOffset until absent.",
		func(ctx context.Context, r AdminPeopleReader, in ListUsersInput) (*ListUsersOutput, error) {
			if err := normaliseQuery(&in.Query); err != nil {
				return nil, err
			}
			switch in.Sort {
			case "":
				in.Sort = "newest"
			case "newest", "last_sign_in":
			default:
				return nil, fmt.Errorf("sort must be newest or last_sign_in")
			}
			if err := normalisePage(&in.Limit, &in.Offset); err != nil {
				return nil, err
			}
			return r.ListUsers(ctx, in)
		})
}

func listPayingUsersTool() AdminTool {
	return peopleTool("list_paying_users", "Paying users",
		"Page through subscriptions from the Stripe webhook mirror (api_subscriptions), newest first: user id, email, tier, status, "+
			"current period end and whether it cancels at period end. Defaults to status=paying (active or trialing); use past_due to find "+
			"failed payments, canceled for churn, all for everything. Follow nextOffset until absent.",
		func(ctx context.Context, r AdminPeopleReader, in ListPayingUsersInput) (*ListPayingUsersOutput, error) {
			in.Status = strings.ToLower(strings.TrimSpace(in.Status))
			if in.Status == "" {
				in.Status = "paying"
			}
			if !slices.Contains(PayingStatuses, in.Status) {
				return nil, fmt.Errorf("status must be one of %s", strings.Join(PayingStatuses, ", "))
			}
			if err := normalisePage(&in.Limit, &in.Offset); err != nil {
				return nil, err
			}
			return r.ListPayingUsers(ctx, in)
		})
}

func listMailingListTool() AdminTool {
	return peopleTool("list_mailing_list", "Mailing list subscribers",
		"Page through mailing list addresses, newest first: email, when it joined and when it unsubscribed. Defaults to subscribed "+
			"(who a broadcast would reach); unsubscribed or all otherwise. Filter with query (an email substring). Follow nextOffset until absent.",
		func(ctx context.Context, r AdminPeopleReader, in ListMailingListInput) (*ListMailingListOutput, error) {
			in.Status = strings.ToLower(strings.TrimSpace(in.Status))
			switch in.Status {
			case "":
				in.Status = "subscribed"
			case "subscribed", "unsubscribed", "all":
			default:
				return nil, fmt.Errorf("status must be subscribed, unsubscribed or all")
			}
			if err := normaliseQuery(&in.Query); err != nil {
				return nil, err
			}
			if err := normalisePage(&in.Limit, &in.Offset); err != nil {
				return nil, err
			}
			return r.ListMailingList(ctx, in)
		})
}

func lookupPersonTool() AdminTool {
	return peopleTool("lookup_person", "Look up a person by email",
		"Everything Shorted holds about one email address across the three sources: the signed-up account, the subscription and the "+
			"mailing list entry. An absent field means there is none, unless warnings says that source could not be read.",
		func(ctx context.Context, r AdminPeopleReader, in LookupPersonInput) (*LookupPersonOutput, error) {
			email := strings.ToLower(strings.TrimSpace(in.Email))
			if addr, err := mail.ParseAddress(email); err != nil || addr.Address != email || len(email) > 254 {
				return nil, fmt.Errorf("email must be a single plain address, e.g. name@example.com")
			}
			in.Email = email
			return r.LookupPerson(ctx, in)
		})
}
