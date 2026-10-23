package shorts

// mcp_admin_billing_web.go: the web app's billing routes, which the admin
// billing tools read through. Only the web app holds the Stripe key, so this
// service asks it, behind the shared INTERNAL_SERVICE_SECRET, exactly as it asks
// for admin-check and admin-users (firebase_users.go, admin_check.go).
//
// Nothing here is cached: each answer is what the billing audit is for.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

const (
	adminWebBillingTimeout = 20 * time.Second
	adminWebMaxBody        = 4 << 20
)

// adminWebClient calls the web app's internal billing and probe routes.
type adminWebClient struct {
	checkURL string // the admin-check URL; the other routes sit beside it
	secret   string
	client   *http.Client
}

// newAdminWebClientFromEnv returns nil without INTERNAL_SERVICE_SECRET: with
// nothing to authenticate the call, the billing tools name Stripe as
// unavailable rather than calling anonymously.
func newAdminWebClientFromEnv() *adminWebClient {
	secret := os.Getenv("INTERNAL_SERVICE_SECRET")
	if secret == "" {
		return nil
	}
	check := strings.TrimSpace(os.Getenv("ADMIN_CHECK_URL"))
	if check == "" {
		check = defaultAdminCheckURL
	}
	return &adminWebClient{checkURL: check, secret: secret, client: &http.Client{}}
}

// route is the URL of one web route, derived from the admin-check URL the same
// way newFirebaseUsersClientFromEnv derives admin-users.
func (c *adminWebClient) route(name string) string {
	return strings.TrimSuffix(c.checkURL, "/admin-check") + "/" + name
}

// webCustomerView is the web app's answer to {"action":"customer"}. An email that
// names more than one Stripe customer is answered with no customer, ambiguous set,
// and the ids it matched, so each can be read by id.
type webCustomerView struct {
	Customer      *webCustomer      `json:"customer"`
	Subscriptions []webSubscription `json:"subscriptions"`
	LatestInvoice *webInvoice       `json:"latestInvoice"`
	Ambiguous     bool              `json:"ambiguous"`
	CustomerIDs   []string          `json:"customerIds"`
}

type webCustomer struct {
	ID      string  `json:"id"`
	Created *string `json:"created"`
}

// webSubscription is one Stripe subscription. PriceID and the subscription id
// are read so the drift check can match rows, and never reach the output.
type webSubscription struct {
	ID                 string  `json:"id"`
	Status             string  `json:"status"`
	Tier               string  `json:"tier"`
	PriceID            string  `json:"priceId"`
	Amount             *int64  `json:"amount"` // nullable: a subscription with no price yet has none
	Currency           string  `json:"currency"`
	Interval           string  `json:"interval"`
	CurrentPeriodStart *string `json:"currentPeriodStart"`
	CurrentPeriodEnd   *string `json:"currentPeriodEnd"`
	CancelAtPeriodEnd  bool    `json:"cancelAtPeriodEnd"`
	Created            *string `json:"created"`
	MetadataUserID     string  `json:"metadataUserId"`
}

type webInvoice struct {
	Status     string  `json:"status"`
	AmountPaid int64   `json:"amountPaid"`
	Currency   string  `json:"currency"`
	Created    *string `json:"created"`
	PaidAt     *string `json:"paidAt"`
}

// webAliveList is the web app's answer to {"action":"alive"}: every live
// subscription (active, trialing, past_due or unpaid), with a truncation flag.
type webAliveList struct {
	Subscriptions []webAliveSubscription `json:"subscriptions"`
	Truncated     bool                   `json:"truncated"`
}

type webAliveSubscription struct {
	CustomerID        string  `json:"customerId"`
	SubscriptionID    string  `json:"subscriptionId"`
	Status            string  `json:"status"`
	Tier              string  `json:"tier"`
	CurrentPeriodEnd  *string `json:"currentPeriodEnd"`
	CancelAtPeriodEnd bool    `json:"cancelAtPeriodEnd"`
	MetadataUserID    string  `json:"metadataUserId"`
	Email             string  `json:"email"`
}

// webProbeReport is the paid-probe route's report (200 or 503).
type webProbeReport struct {
	OK         bool           `json:"ok"`
	StartedAt  string         `json:"startedAt"`
	DurationMs int64          `json:"durationMs"`
	Steps      []webProbeStep `json:"steps"`
	Checkins   string         `json:"checkins"`
}

type webProbeStep struct {
	Name       string `json:"name"`
	OK         bool   `json:"ok"`
	DurationMs int64  `json:"durationMs"`
	Detail     string `json:"detail"`
}

// post sends one internal request and returns the status and body. The secret
// travels in a header and never in the URL or an error message.
func (c *adminWebClient) post(ctx context.Context, name string, body any) (int, []byte, error) {
	var reader io.Reader
	if body != nil {
		payload, err := json.Marshal(body)
		if err != nil {
			return 0, nil, fmt.Errorf("web %s: building request: %w", name, err)
		}
		reader = bytes.NewReader(payload)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.route(name), reader)
	if err != nil {
		return 0, nil, fmt.Errorf("web %s: building request: %w", name, err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("x-internal-secret", c.secret)
	resp, err := c.client.Do(req)
	if err != nil {
		return 0, nil, fmt.Errorf("web %s: %w", name, err)
	}
	defer func() { _ = resp.Body.Close() }()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, adminWebMaxBody))
	if err != nil {
		return 0, nil, fmt.Errorf("web %s: reading response: %w", name, err)
	}
	return resp.StatusCode, raw, nil
}

// statusError names a refusal by its status. 401 is the one an operator can fix
// by reading the secret, so it says so.
// A 403 is the same refusal as a 401 from this side: the web app did not accept the
// internal secret. Both name the secret, so an operator knows what to check.
func statusError(name string, status int) error {
	if status == http.StatusUnauthorized || status == http.StatusForbidden {
		return fmt.Errorf("web %s: HTTP %d (the web app rejected INTERNAL_SERVICE_SECRET)", name, status)
	}
	return fmt.Errorf("web %s: HTTP %d", name, status)
}

// customer reads one Stripe customer, by customer id or by email.
func (c *adminWebClient) customer(ctx context.Context, req webBillingRequest) (*webCustomerView, error) {
	ctx, cancel := context.WithTimeout(ctx, adminWebBillingTimeout)
	defer cancel()
	status, raw, err := c.post(ctx, "billing", req)
	if err != nil {
		return nil, err
	}
	if status != http.StatusOK {
		return nil, statusError("billing", status)
	}
	var out webCustomerView
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, fmt.Errorf("web billing: malformed customer response")
	}
	return &out, nil
}

// aliveSubscriptions reads every live Stripe subscription.
func (c *adminWebClient) aliveSubscriptions(ctx context.Context) (*webAliveList, error) {
	ctx, cancel := context.WithTimeout(ctx, adminWebBillingTimeout)
	defer cancel()
	status, raw, err := c.post(ctx, "billing", webBillingRequest{Action: "alive"})
	if err != nil {
		return nil, err
	}
	if status != http.StatusOK {
		return nil, statusError("billing", status)
	}
	var out webAliveList
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, fmt.Errorf("web billing: malformed alive response")
	}
	return &out, nil
}

// runPaidProbe starts one probe run and waits for it on ctx, which bounds it. It
// returns the status with the report on 200 and 503; 409 (a run already in progress
// on the web side) returns no report and no error. Any other refusal is an error
// that names the status.
func (c *adminWebClient) runPaidProbe(ctx context.Context) (int, *webProbeReport, error) {
	status, raw, err := c.post(ctx, "paid-probe", nil)
	if err != nil {
		return 0, nil, err
	}
	switch status {
	case http.StatusOK, http.StatusServiceUnavailable:
		var report webProbeReport
		if err := json.Unmarshal(raw, &report); err != nil {
			return status, nil, fmt.Errorf("web paid-probe: malformed report")
		}
		return status, &report, nil
	case http.StatusConflict:
		return status, nil, nil
	default:
		return status, nil, statusError("paid-probe", status)
	}
}

// webBillingRequest is the body of POST /api/internal/billing.
type webBillingRequest struct {
	Action     string `json:"action"`
	Email      string `json:"email,omitempty"`
	CustomerID string `json:"customerId,omitempty"`
}

// errWebUnavailable is the state of a deployment with no internal secret.
var errWebUnavailable = errors.New("the web app's billing routes are not configured: INTERNAL_SERVICE_SECRET is not set on the API")
