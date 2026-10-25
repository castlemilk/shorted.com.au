package shorts

// postgres_billing.go: admin-only reads for the billing audit (the admin MCP
// server's check_subscription and list_billing_exceptions tools) and the usage
// half of check_subscription. Every query is read-only, parameterised and
// bounded. Served only behind users:read, like postgres_people.go.
//
// Separate from PeopleStore on purpose: the people tools must keep compiling
// and testing without these reads, and the billing reads carry more columns
// (Stripe ids, period bounds, update times) than the people views should.
//
// Period bounds come back as ::text, exactly as GetAPISubscription reads them,
// so the caller hands the product's own ResolveEntitlement the same input the
// product sees. The pool runs in simple-protocol mode, so created/updated times
// scan as time.Time.

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// BillingStore is the admin billing audit's read surface.
type BillingStore interface {
	// BillingSubscriptionsFor returns the mirror rows keyed by userID or by
	// email (case-insensitively), newest update first. Either may be empty.
	BillingSubscriptionsFor(ctx context.Context, userID, email string) (rows []BillingSubscription, truncated bool, err error)
	// BillingSubscriptionsAll returns up to limit mirror rows, newest update
	// first, and whether there were more.
	BillingSubscriptionsAll(ctx context.Context, limit int) (rows []BillingSubscription, truncated bool, err error)
	// BillingSubscriptionsByCustomers returns the mirror rows that hold the given
	// Stripe customers. A customer whose row is keyed under any user id is found.
	BillingSubscriptionsByCustomers(ctx context.Context, customerIDs []string) ([]BillingSubscription, error)
	// ChatUsage summarises the chat history of the given user ids.
	ChatUsage(ctx context.Context, userIDs []string) (*ChatUsage, error)
	// ChatUsageEvents summarises chat_usage_events (migration 000145) for the
	// given user ids. ErrRelationMissing when the table is not in this database.
	ChatUsageEvents(ctx context.Context, userIDs []string) (*ChatUsageEvents, error)
	// APIUsageByMonth returns the metered request count per month for the
	// given user ids, for the current and the two previous UTC months.
	APIUsageByMonth(ctx context.Context, userIDs []string) ([]APIUsageMonth, error)
}

var _ BillingStore = (*postgresStore)(nil)

// ErrRelationMissing reports that a table the read names is not in this
// database (SQLSTATE 42P01). A missing table is a state the caller reports as
// "not available here"; it is never read as zero.
var ErrRelationMissing = errors.New("relation not present in this database")

const (
	// BillingRowsPerSubject bounds the mirror rows one subject can match. A
	// person with more rows than this is itself the finding, and the caller
	// is told the list was cut.
	BillingRowsPerSubject = 50
	// billingUsageLookback is the chat window the usage reads report.
	billingUsageLookback = "30 days"
)

// BillingSubscription is one api_subscriptions row, with the Stripe ids the
// audit needs to match the row to Stripe. The ids never leave the server; the
// tools print a dashboard link instead.
type BillingSubscription struct {
	UserID               string
	UserEmail            string
	StripeCustomerID     string
	StripeSubscriptionID string
	// Status is empty when StatusNull is set. A NULL status is reported as its own
	// finding; it is never read as "inactive".
	Status             string
	StatusNull         bool
	Tier               string
	CurrentPeriodStart *string // ::text, as GetAPISubscription reads it
	CurrentPeriodEnd   *string // ::text, as GetAPISubscription reads it
	PastDueSince       *string // ::text: when the current past-due run began
	CancelAtPeriodEnd  bool
	CreatedAt          *time.Time
	UpdatedAt          *time.Time
}

// APISubscription is the row in the shape ResolveEntitlement takes.
func (b BillingSubscription) APISubscription() *APISubscription {
	return &APISubscription{
		UserID:               b.UserID,
		UserEmail:            b.UserEmail,
		StripeCustomerID:     b.StripeCustomerID,
		StripeSubscriptionID: b.StripeSubscriptionID,
		Status:               b.Status,
		Tier:                 b.Tier,
		CurrentPeriodStart:   b.CurrentPeriodStart,
		CurrentPeriodEnd:     b.CurrentPeriodEnd,
		PastDueSince:         b.PastDueSince,
		CancelAtPeriodEnd:    b.CancelAtPeriodEnd,
	}
}

// ChatUsage is what chat_conversations and chat_messages say about a user.
type ChatUsage struct {
	Conversations          int
	UserMessagesLast30Days int
	LastUserMessageAt      *time.Time
}

// ChatUsageEvents is chat_usage_events for a user: sends by outcome over the
// last 30 days, and the token totals of those sends.
type ChatUsageEvents struct {
	SendsByOutcome     map[string]int
	InputTokensLast30  int64
	OutputTokensLast30 int64
}

// APIUsageMonth is the metered request count of one UTC month under one identifier:
// "user:<uid>" (API-token and signed-in browser calls) or "oauth:<uid>" (MCP OAuth).
type APIUsageMonth struct {
	Identifier string
	Month      time.Time
	Requests   int64
}

// billingSubscriptionColumns reads status WITHOUT a COALESCE: a NULL status must
// reach the audit as a NULL, not as the 'inactive' a default would make it look
// like. The tier is still defaulted, as the product itself defaults it.
const billingSubscriptionColumns = `user_id, user_email, COALESCE(stripe_customer_id, ''), COALESCE(stripe_subscription_id, ''),
	status, COALESCE(tier, 'free'), current_period_start::text, current_period_end::text, past_due_since::text,
	COALESCE(cancel_at_period_end, false), created_at, updated_at`

func scanBillingSubscription(scan func(dest ...any) error) (BillingSubscription, error) {
	var b BillingSubscription
	var status *string
	err := scan(&b.UserID, &b.UserEmail, &b.StripeCustomerID, &b.StripeSubscriptionID, &status, &b.Tier,
		&b.CurrentPeriodStart, &b.CurrentPeriodEnd, &b.PastDueSince, &b.CancelAtPeriodEnd, &b.CreatedAt, &b.UpdatedAt)
	if status == nil {
		b.StatusNull = true
	} else {
		b.Status = *status
	}
	return b, err
}

// BillingSubscriptionsByCustomers returns the rows that hold the given customers.
// The customer id is UNIQUE, so there is at most one row per customer, and the
// result is bounded by the number of ids asked for.
func (s *postgresStore) BillingSubscriptionsByCustomers(ctx context.Context, customerIDs []string) ([]BillingSubscription, error) {
	if len(customerIDs) == 0 {
		return nil, nil
	}
	ctx, cancel := context.WithTimeout(ctx, peopleQueryTimeout)
	defer cancel()
	rows, err := s.db.Query(ctx, `
		SELECT `+billingSubscriptionColumns+`
		FROM api_subscriptions
		WHERE stripe_customer_id = ANY($1::text[])
		ORDER BY updated_at DESC NULLS LAST, user_id`, customerIDs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []BillingSubscription{}
	for rows.Next() {
		b, err := scanBillingSubscription(rows.Scan)
		if err != nil {
			return nil, err
		}
		out = append(out, b)
	}
	return out, rows.Err()
}

func (s *postgresStore) BillingSubscriptionsFor(ctx context.Context, userID, email string) ([]BillingSubscription, bool, error) {
	if userID == "" && email == "" {
		return nil, false, nil
	}
	ctx, cancel := context.WithTimeout(ctx, peopleQueryTimeout)
	defer cancel()
	// One extra row tells the caller the list was cut without a second query.
	rows, err := s.db.Query(ctx, `
		SELECT `+billingSubscriptionColumns+`
		FROM api_subscriptions
		WHERE ($1::text <> '' AND user_id = $1::text)
		   OR ($2::text <> '' AND lower(user_email) = lower($2::text))
		ORDER BY updated_at DESC NULLS LAST, user_id
		LIMIT $3`, userID, email, BillingRowsPerSubject+1)
	if err != nil {
		return nil, false, err
	}
	return collectBillingRows(rows, BillingRowsPerSubject)
}

func (s *postgresStore) BillingSubscriptionsAll(ctx context.Context, limit int) ([]BillingSubscription, bool, error) {
	ctx, cancel := context.WithTimeout(ctx, peopleQueryTimeout)
	defer cancel()
	rows, err := s.db.Query(ctx, `
		SELECT `+billingSubscriptionColumns+`
		FROM api_subscriptions
		ORDER BY updated_at DESC NULLS LAST, user_id
		LIMIT $1`, limit+1)
	if err != nil {
		return nil, false, err
	}
	return collectBillingRows(rows, limit)
}

// collectBillingRows reads at most limit rows and reports whether the result
// set had more. It closes rows.
func collectBillingRows(rows pgx.Rows, limit int) ([]BillingSubscription, bool, error) {
	defer rows.Close()
	out := []BillingSubscription{}
	for rows.Next() {
		b, err := scanBillingSubscription(rows.Scan)
		if err != nil {
			return nil, false, err
		}
		out = append(out, b)
	}
	if err := rows.Err(); err != nil {
		return nil, false, err
	}
	if len(out) > limit {
		return out[:limit], true, nil
	}
	return out, false, nil
}

func (s *postgresStore) ChatUsage(ctx context.Context, userIDs []string) (*ChatUsage, error) {
	if len(userIDs) == 0 {
		return &ChatUsage{}, nil
	}
	ctx, cancel := context.WithTimeout(ctx, peopleQueryTimeout)
	defer cancel()
	var u ChatUsage
	err := s.db.QueryRow(ctx, `
		SELECT
		  (SELECT count(*) FROM chat_conversations WHERE user_id = ANY($1::text[])),
		  (SELECT count(*) FROM chat_messages m
		     JOIN chat_conversations c ON c.id = m.conversation_id
		    WHERE c.user_id = ANY($1::text[]) AND m.role = 'user'
		      AND m.created_at >= now() - interval '`+billingUsageLookback+`'),
		  (SELECT max(m.created_at) FROM chat_messages m
		     JOIN chat_conversations c ON c.id = m.conversation_id
		    WHERE c.user_id = ANY($1::text[]) AND m.role = 'user')`, userIDs).
		Scan(&u.Conversations, &u.UserMessagesLast30Days, &u.LastUserMessageAt)
	if err != nil {
		return nil, relationMissing(err)
	}
	return &u, nil
}

func (s *postgresStore) ChatUsageEvents(ctx context.Context, userIDs []string) (*ChatUsageEvents, error) {
	out := &ChatUsageEvents{SendsByOutcome: map[string]int{}}
	if len(userIDs) == 0 {
		return out, nil
	}
	ctx, cancel := context.WithTimeout(ctx, peopleQueryTimeout)
	defer cancel()
	rows, err := s.db.Query(ctx, `
		SELECT outcome, count(*), COALESCE(sum(input_tokens), 0), COALESCE(sum(output_tokens), 0)
		FROM chat_usage_events
		WHERE user_id = ANY($1::text[]) AND created_at >= now() - interval '`+billingUsageLookback+`'
		GROUP BY outcome`, userIDs)
	if err != nil {
		return nil, relationMissing(err)
	}
	defer rows.Close()
	for rows.Next() {
		var (
			outcome          string
			count, in, outTk int64
		)
		if err := rows.Scan(&outcome, &count, &in, &outTk); err != nil {
			return nil, err
		}
		out.SendsByOutcome[outcome] += int(count)
		out.InputTokensLast30 += in
		out.OutputTokensLast30 += outTk
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

func (s *postgresStore) APIUsageByMonth(ctx context.Context, userIDs []string) ([]APIUsageMonth, error) {
	identifiers := make([]string, 0, 2*len(userIDs))
	for _, id := range userIDs {
		identifiers = append(identifiers, "user:"+id, "oauth:"+id)
	}
	if len(identifiers) == 0 {
		return nil, nil
	}
	ctx, cancel := context.WithTimeout(ctx, peopleQueryTimeout)
	defer cancel()
	// api_usage_monthly is keyed by "user:<uid>" and one row per identifier and
	// month (migration 000112); period_month is the first day of a UTC month.
	rows, err := s.db.Query(ctx, `
		SELECT identifier, period_month, SUM(request_count)::bigint
		FROM api_usage_monthly
		WHERE identifier = ANY($1::text[])
		  AND period_month >= (date_trunc('month', now() AT TIME ZONE 'UTC') - interval '2 months')::date
		GROUP BY identifier, period_month
		ORDER BY period_month DESC, identifier`, identifiers)
	if err != nil {
		return nil, relationMissing(err)
	}
	defer rows.Close()
	out := []APIUsageMonth{}
	for rows.Next() {
		var m APIUsageMonth
		if err := rows.Scan(&m.Identifier, &m.Month, &m.Requests); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// relationMissing maps SQLSTATE 42P01 (undefined_table) to ErrRelationMissing
// and passes every other error through untouched.
func relationMissing(err error) error {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "42P01" {
		return fmt.Errorf("%w: %s", ErrRelationMissing, pgErr.Message)
	}
	return err
}
