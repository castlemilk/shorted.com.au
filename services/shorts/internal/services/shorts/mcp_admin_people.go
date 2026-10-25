package shorts

// mcp_admin_people.go implements the admin MCP server's users:read tools
// (internal/mcp/admin_people.go) over the three places personal data lives:
// Firebase accounts (via the web app), api_subscriptions and the mailing list.
//
// A source that fails is named, never reported as empty: an overview with the
// subscriptions table down omits "paying" and warns, rather than saying nobody
// pays. Errors returned to the tool are generic; the detail goes to the log.

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/castlemilk/shorted.com.au/services/pkg/log"
	"github.com/castlemilk/shorted.com.au/services/shorts/internal/mcp"
	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
)

var (
	errUsersUnavailable  = errors.New("signed-up accounts could not be read (the web app's admin-users endpoint is unavailable)")
	errPeopleUnavailable = errors.New("subscriptions and the mailing list could not be read")
)

const (
	sourceAccounts      = "firebase_accounts"
	sourceSubscriptions = "api_subscriptions"
	sourceMailingList   = "mailing_list"
)

func (a *adminMCPSource) PeopleOverview(ctx context.Context) (*mcp.PeopleOverviewOutput, error) {
	out := &mcp.PeopleOverviewOutput{ObservedAt: time.Now().UTC().Format(time.RFC3339), Sources: []mcp.JobSource{}, Warnings: []string{}}
	var (
		users            *firebaseUserSummary
		subs             []shortsstore.SubscriptionCount
		mailing          *shortsstore.MailingListCounts
		uErr, sErr, mErr error
		wg               sync.WaitGroup
	)
	wg.Add(3)
	go func() {
		defer wg.Done()
		if a.users == nil {
			uErr = errUsersUnavailable
			return
		}
		users, uErr = a.users.Summary(ctx)
	}()
	go func() {
		defer wg.Done()
		if a.people == nil {
			sErr = errPeopleUnavailable
			return
		}
		subs, sErr = a.people.SubscriptionCounts(ctx)
	}()
	go func() {
		defer wg.Done()
		if a.people == nil {
			mErr = errPeopleUnavailable
			return
		}
		mailing, mErr = a.people.MailingListCounts(ctx)
	}()
	wg.Wait()

	if uErr != nil {
		log.Warnf("admin people_overview: accounts: %v", uErr)
		out.Warnings = append(out.Warnings, "Signed-up account counts could not be read.")
		out.Sources = append(out.Sources, mcp.JobSource{Name: sourceAccounts, Status: "unavailable", Detail: "Firebase Auth, read through the web app."})
	} else {
		byProvider := users.ByProvider
		if byProvider == nil {
			byProvider = map[string]int{}
		}
		out.Users = &mcp.UserCounts{
			Total: users.Total, EmailVerified: users.EmailVerified, Disabled: users.Disabled,
			SignedUpLast7Days: users.SignedUpLast7Days, SignedUpLast30Days: users.SignedUpLast30Days,
			SignedInLast30Days: users.SignedInLast30Days, ByProvider: byProvider, Truncated: users.Truncated,
		}
		detail := "Firebase Auth, read through the web app."
		if users.Truncated {
			detail += " The scan stopped at its cap; counts are lower bounds."
			out.Warnings = append(out.Warnings, "More accounts than the scan reads; account counts are lower bounds.")
		}
		out.Sources = append(out.Sources, mcp.JobSource{Name: sourceAccounts, Status: "available", Detail: detail})
	}

	if sErr != nil {
		log.Warnf("admin people_overview: subscriptions: %v", sErr)
		out.Warnings = append(out.Warnings, "Subscription counts could not be read.")
		out.Sources = append(out.Sources, mcp.JobSource{Name: sourceSubscriptions, Status: "unavailable", Detail: "Stripe webhook mirror in Postgres."})
	} else {
		out.Paying = summarisePaying(subs)
		out.Sources = append(out.Sources, mcp.JobSource{Name: sourceSubscriptions, Status: "available",
			Detail: "Stripe webhook mirror in Postgres; reflects what the webhook last recorded, not a live Stripe read."})
	}

	if mErr != nil {
		log.Warnf("admin people_overview: mailing list: %v", mErr)
		out.Warnings = append(out.Warnings, "Mailing list counts could not be read.")
		out.Sources = append(out.Sources, mcp.JobSource{Name: sourceMailingList, Status: "unavailable", Detail: "subscriptions table in Postgres."})
	} else {
		out.MailingList = &mcp.MailingListCounts{
			Subscribed: mailing.Subscribed, Unsubscribed: mailing.Unsubscribed, JoinedLast7Days: mailing.JoinedLast7Days,
			JoinedLast30Days: mailing.JoinedLast30Days, UnsubscribedLast30Days: mailing.UnsubscribedLast30Days,
		}
		out.Sources = append(out.Sources, mcp.JobSource{Name: sourceMailingList, Status: "available", Detail: "subscriptions table in Postgres."})
	}
	return out, nil
}

// payingStatuses are the subscription statuses that count as paying.
var payingStatuses = []string{"active", "trialing"}

func isPaying(status string) bool {
	return status == "active" || status == "trialing"
}

func summarisePaying(counts []shortsstore.SubscriptionCount) *mcp.PayingCounts {
	p := &mcp.PayingCounts{ByStatus: map[string]int{}, PayingByTier: map[string]int{}}
	for _, c := range counts {
		p.ByStatus[c.Status] += c.Count
		p.NewLast30Days += c.NewLast30Days
		if isPaying(c.Status) {
			p.Paying += c.Count
			p.PayingByTier[c.Tier] += c.Count
			if c.CancelAtPeriodEnd {
				p.CancellingAtPeriodEnd += c.Count
			}
		}
	}
	return p
}

func (a *adminMCPSource) ListUsers(ctx context.Context, in mcp.ListUsersInput) (*mcp.ListUsersOutput, error) {
	if a.users == nil {
		return nil, errUsersUnavailable
	}
	page, err := a.users.List(ctx, in.Query, in.Sort, in.Limit, in.Offset)
	if err != nil {
		log.Warnf("admin list_users: %v", err)
		return nil, errUsersUnavailable
	}
	out := &mcp.ListUsersOutput{Users: make([]mcp.UserRow, 0, len(page.Users)), Total: page.Total, Truncated: page.Truncated}
	out.NextOffset = mcp.NextOffset(in.Offset, len(page.Users), page.Total)

	// Annotate the page with plan and mailing list membership. Either lookup
	// failing leaves its field out (unknown), never false.
	var plans map[string]shortsstore.AdminSubscription
	var mailing map[string]bool
	if a.people != nil && len(page.Users) > 0 {
		ids := make([]string, 0, len(page.Users))
		emails := make([]string, 0, len(page.Users))
		for _, u := range page.Users {
			ids = append(ids, u.UID)
			if u.Email != "" {
				emails = append(emails, u.Email)
			}
		}
		var pErr, mErr error
		if plans, pErr = a.people.SubscriptionsByUserIDs(ctx, ids); pErr != nil {
			log.Warnf("admin list_users: plans: %v", pErr)
			plans = nil
			out.Warnings = append(out.Warnings, "Plans could not be read; plan is omitted.")
		}
		if mailing, mErr = a.people.SubscribedEmails(ctx, emails); mErr != nil {
			log.Warnf("admin list_users: mailing list: %v", mErr)
			mailing = nil
			out.Warnings = append(out.Warnings, "The mailing list could not be read; onMailingList is omitted.")
		}
	} else if a.people == nil && len(page.Users) > 0 {
		out.Warnings = append(out.Warnings, "Plans and mailing list membership are unavailable in this deployment.")
	}
	for _, u := range page.Users {
		row := userRow(u)
		if plans != nil {
			if sub, ok := plans[u.UID]; ok {
				row.Plan = planLabel(sub)
			} else {
				row.Plan = "free"
			}
		}
		if mailing != nil && u.Email != "" {
			on := mailing[strings.ToLower(u.Email)]
			row.OnMailingList = &on
		}
		out.Users = append(out.Users, row)
	}
	return out, nil
}

func userRow(u firebaseUser) mcp.UserRow {
	providers := u.Providers
	if providers == nil {
		providers = []string{}
	}
	return mcp.UserRow{
		UserID: u.UID, Email: u.Email, EmailVerified: u.EmailVerified, Disabled: u.Disabled,
		Providers: providers, CreatedAt: u.CreatedAt, LastSignInAt: u.LastSignInAt,
	}
}

func planLabel(s shortsstore.AdminSubscription) string {
	return fmt.Sprintf("%s (%s)", s.Tier, s.Status)
}

func (a *adminMCPSource) ListPayingUsers(ctx context.Context, in mcp.ListPayingUsersInput) (*mcp.ListPayingUsersOutput, error) {
	if a.people == nil {
		return nil, errPeopleUnavailable
	}
	var statuses []string
	switch in.Status {
	case "all":
	case "paying":
		statuses = payingStatuses
	default:
		statuses = []string{in.Status}
	}
	rows, total, err := a.people.ListAdminSubscriptions(ctx, statuses, in.Limit, in.Offset)
	if err != nil {
		log.Warnf("admin list_paying_users: %v", err)
		return nil, errors.New("subscriptions could not be read")
	}
	out := &mcp.ListPayingUsersOutput{Subscriptions: make([]mcp.PayingUserRow, 0, len(rows)), Total: total}
	now := time.Now()
	for _, r := range rows {
		out.Subscriptions = append(out.Subscriptions, payingRow(r, now))
	}
	out.NextOffset = mcp.NextOffset(in.Offset, len(rows), total)
	return out, nil
}

// payingRow renders a subscription row. The entitlement is the product's own
// verdict for the row at now, so the list cannot disagree with the features.
func payingRow(r shortsstore.AdminSubscription, now time.Time) mcp.PayingUserRow {
	ent := ResolveEntitlement(r.UserID, adminSubscriptionAPI(r), now)
	return mcp.PayingUserRow{
		UserID: r.UserID, Email: r.Email, Tier: r.Tier, Status: r.Status,
		CurrentPeriodEnd: rfc3339(r.CurrentPeriodEnd), CancelAtPeriodEnd: r.CancelAtPeriodEnd, CreatedAt: rfc3339(r.CreatedAt),
		Entitled: ent.Entitled, EntitlementReason: ent.Reason,
	}
}

// adminSubscriptionAPI is the row in the shape ResolveEntitlement reads. The
// period end goes back as RFC3339 with its fraction, which parseStoreTimestamp
// accepts, so the verdict is the same one the product reaches.
func adminSubscriptionAPI(r shortsstore.AdminSubscription) *shortsstore.APISubscription {
	var end *string
	if r.CurrentPeriodEnd != nil {
		text := r.CurrentPeriodEnd.UTC().Format(time.RFC3339Nano)
		end = &text
	}
	var pastDue *string
	if r.PastDueSince != nil {
		text := r.PastDueSince.UTC().Format(time.RFC3339Nano)
		pastDue = &text
	}
	return &shortsstore.APISubscription{
		UserID: r.UserID, UserEmail: r.Email, Status: r.Status, Tier: r.Tier,
		CurrentPeriodEnd: end, CancelAtPeriodEnd: r.CancelAtPeriodEnd,
		PastDueSince: pastDue,
	}
}

func (a *adminMCPSource) ListMailingList(ctx context.Context, in mcp.ListMailingListInput) (*mcp.ListMailingListOutput, error) {
	if a.people == nil {
		return nil, errPeopleUnavailable
	}
	rows, total, err := a.people.ListMailingList(ctx, in.Status, in.Query, in.Limit, in.Offset)
	if err != nil {
		log.Warnf("admin list_mailing_list: %v", err)
		return nil, errors.New("the mailing list could not be read")
	}
	out := &mcp.ListMailingListOutput{Subscribers: make([]mcp.MailingListRow, 0, len(rows)), Total: total}
	for _, r := range rows {
		out.Subscribers = append(out.Subscribers, mailingRow(r))
	}
	out.NextOffset = mcp.NextOffset(in.Offset, len(rows), total)
	return out, nil
}

func mailingRow(r shortsstore.MailingListEntry) mcp.MailingListRow {
	return mcp.MailingListRow{Email: r.Email, SubscribedAt: rfc3339(r.CreatedAt), UnsubscribedAt: rfc3339(r.UnsubscribedAt)}
}

func (a *adminMCPSource) LookupPerson(ctx context.Context, in mcp.LookupPersonInput) (*mcp.LookupPersonOutput, error) {
	out := &mcp.LookupPersonOutput{Email: in.Email}
	var (
		user             *firebaseUser
		sub              *shortsstore.AdminSubscription
		entry            *shortsstore.MailingListEntry
		uErr, sErr, mErr error
		wg               sync.WaitGroup
	)
	wg.Add(3)
	go func() {
		defer wg.Done()
		if a.users == nil {
			uErr = errUsersUnavailable
			return
		}
		user, uErr = a.users.Lookup(ctx, in.Email)
	}()
	go func() {
		defer wg.Done()
		if a.people == nil {
			sErr = errPeopleUnavailable
			return
		}
		sub, sErr = a.people.SubscriptionByEmail(ctx, in.Email)
	}()
	go func() {
		defer wg.Done()
		if a.people == nil {
			mErr = errPeopleUnavailable
			return
		}
		entry, mErr = a.people.MailingListEntryByEmail(ctx, in.Email)
	}()
	wg.Wait()

	// A subscription is keyed by user id; the email on it is whatever Stripe
	// checkout recorded. Prefer the row for the account's own uid when there
	// is an account, so a changed email still finds its plan.
	if user != nil && a.people != nil {
		if byID, err := a.people.SubscriptionsByUserIDs(ctx, []string{user.UID}); err == nil {
			if s, ok := byID[user.UID]; ok {
				sub, sErr = &s, nil
			}
		}
	}

	if uErr != nil {
		log.Warnf("admin lookup_person: accounts: %v", uErr)
		out.Warnings = append(out.Warnings, "Signed-up accounts could not be read; account is unknown.")
	} else if user != nil {
		row := userRow(*user)
		out.Account = &row
	}
	if sErr != nil {
		log.Warnf("admin lookup_person: subscriptions: %v", sErr)
		out.Warnings = append(out.Warnings, "Subscriptions could not be read; subscription is unknown.")
	} else if sub != nil {
		row := payingRow(*sub, time.Now())
		out.Subscription = &row
		if out.Account != nil {
			out.Account.Plan = planLabel(*sub)
		}
	} else if out.Account != nil {
		out.Account.Plan = "free"
	}
	if mErr != nil {
		log.Warnf("admin lookup_person: mailing list: %v", mErr)
		out.Warnings = append(out.Warnings, "The mailing list could not be read; mailingList is unknown.")
	} else if entry != nil {
		row := mailingRow(*entry)
		out.MailingList = &row
		if out.Account != nil {
			on := entry.UnsubscribedAt == nil
			out.Account.OnMailingList = &on
		}
	} else if out.Account != nil {
		off := false
		out.Account.OnMailingList = &off
	}
	return out, nil
}

func rfc3339(t *time.Time) string {
	if t == nil || t.IsZero() {
		return ""
	}
	return t.UTC().Format(time.RFC3339)
}
