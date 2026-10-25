package shorts

// postgres_people.go: admin-only reads of personal data — paying subscriptions
// (api_subscriptions, the Stripe webhook mirror) and the mailing list
// (subscriptions). Served only by the admin MCP server's users:read tools.
//
// Deliberately NOT part of Store: those reads have one caller, behind admin
// authentication, and keeping them off the main interface keeps them out of
// every mock and adapter that has no business with personal data. Reach it
// with a type assertion, as with Pool().
//
// The mailing list table differs between environments: prod has (id, email,
// created_at, unsubscribed_at); dev adds status and updated_at. Only the four
// prod columns are read.

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

// PeopleStore is the admin personal-data read surface.
type PeopleStore interface {
	SubscriptionCounts(ctx context.Context) ([]SubscriptionCount, error)
	MailingListCounts(ctx context.Context) (*MailingListCounts, error)
	ListAdminSubscriptions(ctx context.Context, statuses []string, limit, offset int) ([]AdminSubscription, int, error)
	ListMailingList(ctx context.Context, status, query string, limit, offset int) ([]MailingListEntry, int, error)
	SubscriptionsByUserIDs(ctx context.Context, userIDs []string) (map[string]AdminSubscription, error)
	SubscribedEmails(ctx context.Context, emails []string) (map[string]bool, error)
	SubscriptionByEmail(ctx context.Context, email string) (*AdminSubscription, error)
	MailingListEntryByEmail(ctx context.Context, email string) (*MailingListEntry, error)
}

var _ PeopleStore = (*postgresStore)(nil)

// SubscriptionCount is one (status, tier, cancel_at_period_end) bucket.
type SubscriptionCount struct {
	Status            string
	Tier              string
	CancelAtPeriodEnd bool
	Count             int
	NewLast30Days     int
}

// MailingListCounts summarises the mailing list.
type MailingListCounts struct {
	Subscribed             int
	Unsubscribed           int
	JoinedLast7Days        int
	JoinedLast30Days       int
	UnsubscribedLast30Days int
}

// AdminSubscription is the admin view of an api_subscriptions row. No Stripe
// ids: the admin tools do not expose them.
type AdminSubscription struct {
	UserID           string
	Email            string
	Tier             string
	Status           string
	CurrentPeriodEnd *time.Time
	// PastDueSince starts the past-due grace (see subscription.PastDueGrace).
	PastDueSince      *time.Time
	CancelAtPeriodEnd bool
	CreatedAt         *time.Time
}

// MailingListEntry is one mailing list address.
type MailingListEntry struct {
	Email          string
	CreatedAt      *time.Time
	UnsubscribedAt *time.Time
}

const peopleQueryTimeout = 10 * time.Second

const adminSubscriptionColumns = `user_id, user_email, COALESCE(tier, 'free'), COALESCE(status, 'inactive'),
	current_period_end, past_due_since, COALESCE(cancel_at_period_end, false), created_at`

func scanAdminSubscription(row pgx.Row) (AdminSubscription, error) {
	var a AdminSubscription
	err := row.Scan(&a.UserID, &a.Email, &a.Tier, &a.Status, &a.CurrentPeriodEnd, &a.PastDueSince, &a.CancelAtPeriodEnd, &a.CreatedAt)
	return a, err
}

func (s *postgresStore) SubscriptionCounts(ctx context.Context) ([]SubscriptionCount, error) {
	ctx, cancel := context.WithTimeout(ctx, peopleQueryTimeout)
	defer cancel()
	rows, err := s.db.Query(ctx, `
		SELECT COALESCE(status, 'inactive'), COALESCE(tier, 'free'), COALESCE(cancel_at_period_end, false),
		       count(*), count(*) FILTER (WHERE created_at >= now() - interval '30 days')
		FROM api_subscriptions
		GROUP BY 1, 2, 3`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []SubscriptionCount{}
	for rows.Next() {
		var c SubscriptionCount
		if err := rows.Scan(&c.Status, &c.Tier, &c.CancelAtPeriodEnd, &c.Count, &c.NewLast30Days); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

func (s *postgresStore) MailingListCounts(ctx context.Context) (*MailingListCounts, error) {
	ctx, cancel := context.WithTimeout(ctx, peopleQueryTimeout)
	defer cancel()
	var c MailingListCounts
	err := s.db.QueryRow(ctx, `
		SELECT count(*) FILTER (WHERE unsubscribed_at IS NULL),
		       count(*) FILTER (WHERE unsubscribed_at IS NOT NULL),
		       count(*) FILTER (WHERE created_at >= now() - interval '7 days'),
		       count(*) FILTER (WHERE created_at >= now() - interval '30 days'),
		       count(*) FILTER (WHERE unsubscribed_at >= now() - interval '30 days')
		FROM subscriptions`).Scan(&c.Subscribed, &c.Unsubscribed, &c.JoinedLast7Days, &c.JoinedLast30Days, &c.UnsubscribedLast30Days)
	if err != nil {
		return nil, err
	}
	return &c, nil
}

// ListAdminSubscriptions pages api_subscriptions newest first. An empty
// statuses list means every status.
func (s *postgresStore) ListAdminSubscriptions(ctx context.Context, statuses []string, limit, offset int) ([]AdminSubscription, int, error) {
	if statuses == nil {
		statuses = []string{} // a nil slice is sent as NULL, which matches nothing
	}
	ctx, cancel := context.WithTimeout(ctx, peopleQueryTimeout)
	defer cancel()
	var total int
	if err := s.db.QueryRow(ctx, `
		SELECT count(*) FROM api_subscriptions
		WHERE cardinality($1::text[]) = 0 OR COALESCE(status, 'inactive') = ANY($1)`, statuses).Scan(&total); err != nil {
		return nil, 0, err
	}
	rows, err := s.db.Query(ctx, `
		SELECT `+adminSubscriptionColumns+`
		FROM api_subscriptions
		WHERE cardinality($1::text[]) = 0 OR COALESCE(status, 'inactive') = ANY($1)
		ORDER BY created_at DESC NULLS LAST, user_id
		LIMIT $2 OFFSET $3`, statuses, limit, offset)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	out := []AdminSubscription{}
	for rows.Next() {
		a, err := scanAdminSubscription(rows)
		if err != nil {
			return nil, 0, err
		}
		out = append(out, a)
	}
	return out, total, rows.Err()
}

// mailingListFilter is shared by the count and the page so they always agree.
// $1 is the status (subscribed, unsubscribed, all), $2 a lower-case substring.
const mailingListFilter = `
	WHERE ($1 = 'all'
	       OR ($1 = 'subscribed' AND unsubscribed_at IS NULL)
	       OR ($1 = 'unsubscribed' AND unsubscribed_at IS NOT NULL))
	  AND ($2 = '' OR strpos(lower(email), $2) > 0)`

// ListMailingList pages the mailing list newest first.
func (s *postgresStore) ListMailingList(ctx context.Context, status, query string, limit, offset int) ([]MailingListEntry, int, error) {
	ctx, cancel := context.WithTimeout(ctx, peopleQueryTimeout)
	defer cancel()
	query = strings.ToLower(query)
	var total int
	if err := s.db.QueryRow(ctx, `SELECT count(*) FROM subscriptions`+mailingListFilter, status, query).Scan(&total); err != nil {
		return nil, 0, err
	}
	rows, err := s.db.Query(ctx, `
		SELECT email, created_at::timestamptz, unsubscribed_at FROM subscriptions`+mailingListFilter+`
		ORDER BY created_at DESC NULLS LAST, email
		LIMIT $3 OFFSET $4`, status, query, limit, offset)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	out := []MailingListEntry{}
	for rows.Next() {
		var e MailingListEntry
		if err := rows.Scan(&e.Email, &e.CreatedAt, &e.UnsubscribedAt); err != nil {
			return nil, 0, err
		}
		out = append(out, e)
	}
	return out, total, rows.Err()
}

// SubscriptionsByUserIDs returns the subscription row for each user id that
// has one.
func (s *postgresStore) SubscriptionsByUserIDs(ctx context.Context, userIDs []string) (map[string]AdminSubscription, error) {
	out := map[string]AdminSubscription{}
	if len(userIDs) == 0 {
		return out, nil
	}
	ctx, cancel := context.WithTimeout(ctx, peopleQueryTimeout)
	defer cancel()
	rows, err := s.db.Query(ctx, `SELECT `+adminSubscriptionColumns+` FROM api_subscriptions WHERE user_id = ANY($1)`, userIDs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		a, err := scanAdminSubscription(rows)
		if err != nil {
			return nil, err
		}
		out[a.UserID] = a
	}
	return out, rows.Err()
}

// SubscribedEmails reports, for each lower-cased email, whether it is on the
// mailing list and still subscribed. Emails absent from the map are not.
func (s *postgresStore) SubscribedEmails(ctx context.Context, emails []string) (map[string]bool, error) {
	out := map[string]bool{}
	if len(emails) == 0 {
		return out, nil
	}
	lower := make([]string, len(emails))
	for i, e := range emails {
		lower[i] = strings.ToLower(e)
	}
	ctx, cancel := context.WithTimeout(ctx, peopleQueryTimeout)
	defer cancel()
	rows, err := s.db.Query(ctx, `SELECT DISTINCT lower(email) FROM subscriptions WHERE lower(email) = ANY($1) AND unsubscribed_at IS NULL`, lower)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var e string
		if err := rows.Scan(&e); err != nil {
			return nil, err
		}
		out[e] = true
	}
	return out, rows.Err()
}

// SubscriptionByEmail returns the subscription whose email matches, or nil.
func (s *postgresStore) SubscriptionByEmail(ctx context.Context, email string) (*AdminSubscription, error) {
	ctx, cancel := context.WithTimeout(ctx, peopleQueryTimeout)
	defer cancel()
	a, err := scanAdminSubscription(s.db.QueryRow(ctx, `
		SELECT `+adminSubscriptionColumns+` FROM api_subscriptions
		WHERE lower(user_email) = lower($1)
		ORDER BY updated_at DESC NULLS LAST LIMIT 1`, email))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &a, nil
}

// MailingListEntryByEmail returns the mailing list entry for an email, or nil.
func (s *postgresStore) MailingListEntryByEmail(ctx context.Context, email string) (*MailingListEntry, error) {
	ctx, cancel := context.WithTimeout(ctx, peopleQueryTimeout)
	defer cancel()
	var e MailingListEntry
	err := s.db.QueryRow(ctx, `
		SELECT email, created_at::timestamptz, unsubscribed_at FROM subscriptions
		WHERE lower(email) = lower($1)
		ORDER BY unsubscribed_at IS NULL DESC, created_at DESC NULLS LAST LIMIT 1`, email).
		Scan(&e.Email, &e.CreatedAt, &e.UnsubscribedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &e, nil
}
