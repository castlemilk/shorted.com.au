package mcp

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

// lastBilling records the last normalised input each billing tool handed the
// reader. Tests run sequentially, so a package variable is enough.
var lastBilling struct {
	check      CheckSubscriptionInput
	exceptions BillingExceptionsInput
}

func (f *fakePublisher) CheckSubscription(_ context.Context, in CheckSubscriptionInput) (*CheckSubscriptionOutput, error) {
	lastBilling.check = in
	return &CheckSubscriptionOutput{
		ObservedAt:  "2026-10-23T00:00:00Z",
		Email:       in.Email,
		UserID:      in.UserID,
		Account:     nil, // the accounts source is unavailable, and the output says so
		Mirror:      []BillingMirrorRow{{UserID: "uid-1", Email: "ada@example.com", Tier: "premium", Status: new("active")}},
		Entitlement: &SubscriberEntitlement{UserID: "uid-1", Entitled: true, Tier: "premium", Reason: "active", Source: "stripe", Basis: "user id"},
		Stripe:      []BillingStripeView{},
		Drift:       []BillingDriftFinding{{Kind: "missing_period_end", Detail: "Stripe has a period end; the mirror has none"}},
		Usage:       nil,
		Sources:     []JobSource{{Name: "stripe", Status: "unavailable", Detail: "the web app did not answer"}},
		Notes:       []string{},
	}, nil
}

func (f *fakePublisher) BillingExceptions(_ context.Context, in BillingExceptionsInput) (*BillingExceptionsOutput, error) {
	lastBilling.exceptions = in
	return &BillingExceptionsOutput{
		ObservedAt: "2026-10-23T00:00:00Z",
		Counts:     &BillingExceptionCounts{"paid_without_mirror": 1},
		Rows:       []BillingExceptionRow{{Kind: "paid_without_mirror", Email: "new@example.com", Detail: "live subscription, no mirror row"}},
		Sources:    []JobSource{{Name: "api_subscriptions", Status: "available"}},
		Notes:      []string{},
	}, nil
}

// The billing tools each need one scope, and no other admin scope reaches them.
var billingToolScopes = map[string]string{
	`{"name":"check_subscription","arguments":{"email":"ada@example.com"}}`: ScopeUsersRead,
	`{"name":"list_billing_exceptions","arguments":{}}`:                     ScopeUsersRead,
	`{"name":"paid_feature_status","arguments":{}}`:                         ScopeJobsRead,
	`{"name":"run_paid_probe","arguments":{}}`:                              ScopeJobsRun,
}

func TestBillingAndProbeToolsRequireTheirOwnScope(t *testing.T) {
	for params, want := range billingToolScopes {
		for _, scope := range AdminScopes {
			body := peopleCall(t, []string{scope}, params)
			denied := strings.Contains(body, `"isError":true`)
			if denied != (scope != want) {
				t.Fatalf("scope %s, %s: denied = %v, body %s", scope, params, denied, body)
			}
			if denied && !strings.Contains(body, want) {
				t.Fatalf("refusal does not name %s: %s", want, body)
			}
		}
	}
}

func TestCheckSubscriptionTakesExactlyOneKey(t *testing.T) {
	lastBilling.check = CheckSubscriptionInput{}
	ok := peopleCall(t, nil, `{"name":"check_subscription","arguments":{"email":"  Ada@Example.COM "}}`)
	if strings.Contains(ok, `"isError":true`) || lastBilling.check.Email != "ada@example.com" || lastBilling.check.UserID != "" {
		t.Fatalf("email input = %+v, body %s", lastBilling.check, ok)
	}
	// Stripe is asked with the email as typed (trimmed, not case-folded).
	if lastBilling.check.EmailAsTyped != "Ada@Example.COM" {
		t.Fatalf("EmailAsTyped = %q, want the email as typed", lastBilling.check.EmailAsTyped)
	}

	lastBilling.check = CheckSubscriptionInput{}
	ok = peopleCall(t, nil, `{"name":"check_subscription","arguments":{"userId":"uid-1"}}`)
	if strings.Contains(ok, `"isError":true`) || lastBilling.check.UserID != "uid-1" || lastBilling.check.Email != "" {
		t.Fatalf("userId input = %+v, body %s", lastBilling.check, ok)
	}

	for _, args := range []string{
		`{}`,
		`{"email":"ada@example.com","userId":"uid-1"}`,
		`{"email":"not-an-email"}`,
		`{"email":"Ben <ben@example.com>"}`,
		`{"userId":"uid 1"}`,
		`{"userId":"   "}`,
		`{"userId":"` + strings.Repeat("u", 129) + `"}`,
	} {
		if body := peopleCall(t, nil, `{"name":"check_subscription","arguments":`+args+`}`); !strings.Contains(body, `"isError":true`) {
			t.Errorf("accepted %s: %s", args, body)
		}
	}
}

func TestBillingExceptionsBoundsItsLimit(t *testing.T) {
	lastBilling.exceptions = BillingExceptionsInput{}
	peopleCall(t, nil, `{"name":"list_billing_exceptions","arguments":{}}`)
	if lastBilling.exceptions.Limit != 25 {
		t.Fatalf("default limit = %d, want 25", lastBilling.exceptions.Limit)
	}
	peopleCall(t, nil, `{"name":"list_billing_exceptions","arguments":{"limit":100}}`)
	if lastBilling.exceptions.Limit != 100 {
		t.Fatalf("limit = %d, want 100", lastBilling.exceptions.Limit)
	}
	for _, args := range []string{`{"limit":101}`, `{"limit":-1}`} {
		if body := peopleCall(t, nil, `{"name":"list_billing_exceptions","arguments":`+args+`}`); !strings.Contains(body, `"isError":true`) {
			t.Errorf("accepted %s: %s", args, body)
		}
	}
}

// A null section is a source that could not be read, and must reach the model
// as null, not be dropped. An empty list is a read that found nothing.
func TestCheckSubscriptionKeepsUnreadSectionsNull(t *testing.T) {
	body := peopleCall(t, nil, `{"name":"check_subscription","arguments":{"email":"ada@example.com"}}`)
	for _, want := range []string{`"account":null`, `"usage":null`, `"stripe":[]`, `"name":"stripe"`, `"status":"unavailable"`} {
		if !strings.Contains(body, want) {
			t.Fatalf("body lacks %s: %s", want, body)
		}
	}
	if strings.Contains(body, `"stripeDashboardUrl":""`) || strings.Contains(body, "cus_") || strings.Contains(body, "sub_") {
		t.Fatalf("a Stripe id or an empty dashboard link reached the model: %s", body)
	}
}

// Read tools say so, and the one action says it is not read-only.
func TestBillingToolsAreAnnotatedHonestly(t *testing.T) {
	ctx := context.Background()
	server := NewAdminServer(&fakePublisher{})
	clientT, serverT := sdk.NewInMemoryTransports()
	if _, err := server.Connect(ctx, serverT, nil); err != nil {
		t.Fatal(err)
	}
	session, err := sdk.NewClient(&sdk.Implementation{Name: "t", Version: "1"}, nil).Connect(ctx, clientT, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = session.Close() }()
	res, err := session.ListTools(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	readOnly := map[string]bool{}
	for _, tool := range res.Tools {
		if tool.Annotations != nil {
			readOnly[tool.Name] = tool.Annotations.ReadOnlyHint
		}
	}
	for _, name := range []string{"check_subscription", "list_billing_exceptions", "paid_feature_status"} {
		if !readOnly[name] {
			t.Errorf("%s is not annotated read-only", name)
		}
	}
	if readOnly["run_paid_probe"] {
		t.Error("run_paid_probe is annotated read-only; it starts a probe run")
	}
}

// Both billing tools publish the subscription_user_mismatch kind in their output
// schema, so a client reading the tool list knows the finding exists. Read from the
// tools the server lists, not from the Go struct.
func TestBillingToolsPublishTheSubscriptionUserMismatchKind(t *testing.T) {
	ctx := context.Background()
	server := NewAdminServer(&fakePublisher{})
	clientT, serverT := sdk.NewInMemoryTransports()
	if _, err := server.Connect(ctx, serverT, nil); err != nil {
		t.Fatal(err)
	}
	session, err := sdk.NewClient(&sdk.Implementation{Name: "t", Version: "1"}, nil).Connect(ctx, clientT, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = session.Close() }()
	res, err := session.ListTools(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"check_subscription", "list_billing_exceptions"} {
		var found *sdk.Tool
		for _, tool := range res.Tools {
			if tool.Name == name {
				found = tool
			}
		}
		if found == nil {
			t.Fatalf("%s is not listed", name)
		}
		raw, err := json.Marshal(found)
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(string(raw), "subscription_user_mismatch") {
			t.Errorf("%s does not publish the subscription_user_mismatch kind", name)
		}
	}
}
