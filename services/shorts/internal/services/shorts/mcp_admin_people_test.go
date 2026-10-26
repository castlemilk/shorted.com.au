package shorts

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/castlemilk/shorted.com.au/services/shorts/internal/mcp"
	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
)

type fakePeopleStore struct {
	failSubs, failMailing bool
	statuses              []string
}

func (f *fakePeopleStore) SubscriptionCounts(context.Context) ([]shortsstore.SubscriptionCount, error) {
	if f.failSubs {
		return nil, errors.New("down")
	}
	return []shortsstore.SubscriptionCount{
		{Status: "active", Tier: "premium", Count: 3, NewLast30Days: 1},
		{Status: "active", Tier: "premium", CancelAtPeriodEnd: true, Count: 1},
		{Status: "trialing", Tier: "enterprise", Count: 1},
		{Status: "canceled", Tier: "premium", Count: 4, NewLast30Days: 2},
	}, nil
}
func (f *fakePeopleStore) MailingListCounts(context.Context) (*shortsstore.MailingListCounts, error) {
	if f.failMailing {
		return nil, errors.New("down")
	}
	return &shortsstore.MailingListCounts{Subscribed: 4}, nil
}
func (f *fakePeopleStore) ListAdminSubscriptions(_ context.Context, statuses []string, _, _ int) ([]shortsstore.AdminSubscription, int, error) {
	f.statuses = statuses
	return nil, 0, nil
}
func (f *fakePeopleStore) ListMailingList(context.Context, string, string, int, int) ([]shortsstore.MailingListEntry, int, error) {
	return nil, 0, nil
}
func (f *fakePeopleStore) SubscriptionsByUserIDs(_ context.Context, ids []string) (map[string]shortsstore.AdminSubscription, error) {
	if f.failSubs {
		return nil, errors.New("down")
	}
	out := map[string]shortsstore.AdminSubscription{}
	for _, id := range ids {
		if id == "uid-paying" {
			out[id] = shortsstore.AdminSubscription{UserID: id, Email: "old@example.com", Tier: "premium", Status: "active"}
		}
	}
	return out, nil
}
func (f *fakePeopleStore) SubscribedEmails(_ context.Context, emails []string) (map[string]bool, error) {
	if f.failMailing {
		return nil, errors.New("down")
	}
	return map[string]bool{"news@example.com": true}, nil
}
func (f *fakePeopleStore) SubscriptionByEmail(context.Context, string) (*shortsstore.AdminSubscription, error) {
	return nil, nil
}
func (f *fakePeopleStore) MailingListEntryByEmail(_ context.Context, email string) (*shortsstore.MailingListEntry, error) {
	if email == "news@example.com" {
		t := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
		return &shortsstore.MailingListEntry{Email: email, CreatedAt: &t}, nil
	}
	return nil, nil
}

type fakeFirebaseUsers struct{ fail bool }

func (f fakeFirebaseUsers) Summary(context.Context) (*firebaseUserSummary, error) {
	if f.fail {
		return nil, errors.New("down")
	}
	return &firebaseUserSummary{Total: 7}, nil
}
func (f fakeFirebaseUsers) List(context.Context, string, string, int, int) (*firebaseUserPage, error) {
	return &firebaseUserPage{Users: []firebaseUser{
		{UID: "uid-paying", Email: "Paid@Example.com"},
		{UID: "uid-free", Email: "news@example.com"},
	}, Total: 2}, nil
}
func (f fakeFirebaseUsers) Lookup(_ context.Context, email string) (*firebaseUser, error) {
	if email == "paid@example.com" {
		return &firebaseUser{UID: "uid-paying", Email: email}, nil
	}
	return nil, nil
}

// LookupUID answers from the same accounts as Lookup, by uid.
func (f fakeFirebaseUsers) LookupUID(_ context.Context, uid string) (*firebaseUser, error) {
	if uid == "uid-paying" {
		return &firebaseUser{UID: uid, Email: "paid@example.com", EmailVerified: true}, nil
	}
	return nil, nil
}

func TestPeopleOverviewSummarisesAndNamesFailures(t *testing.T) {
	src := &adminMCPSource{people: &fakePeopleStore{failMailing: true}, users: fakeFirebaseUsers{}}
	out, err := src.PeopleOverview(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if out.Users == nil || out.Users.Total != 7 {
		t.Fatalf("users = %+v", out.Users)
	}
	p := out.Paying
	if p.Paying != 5 || p.PayingByTier["premium"] != 4 || p.PayingByTier["enterprise"] != 1 || p.CancellingAtPeriodEnd != 1 || p.ByStatus["canceled"] != 4 || p.NewLast30Days != 3 {
		t.Fatalf("paying = %+v", p)
	}
	if out.MailingList != nil || len(out.Warnings) != 1 {
		t.Fatalf("mailing list failure not named: %+v %v", out.MailingList, out.Warnings)
	}

	// No web endpoint and no Postgres: every source unavailable, none zero.
	out, err = (&adminMCPSource{}).PeopleOverview(context.Background())
	if err != nil || out.Users != nil || out.Paying != nil || out.MailingList != nil || len(out.Warnings) != 3 {
		t.Fatalf("overview without sources = %+v, %v", out, err)
	}
}

func TestListUsersAnnotatesPlanAndMailingList(t *testing.T) {
	src := &adminMCPSource{people: &fakePeopleStore{}, users: fakeFirebaseUsers{}}
	out, err := src.ListUsers(context.Background(), mcp.ListUsersInput{Limit: 25})
	if err != nil {
		t.Fatal(err)
	}
	if out.Users[0].Plan != "premium (active)" || out.Users[1].Plan != "free" {
		t.Fatalf("plans = %q, %q", out.Users[0].Plan, out.Users[1].Plan)
	}
	if *out.Users[0].OnMailingList || !*out.Users[1].OnMailingList {
		t.Fatal("mailing list membership wrong")
	}

	// A failed lookup leaves the field out rather than saying "free" / false.
	src.people = &fakePeopleStore{failSubs: true, failMailing: true}
	out, _ = src.ListUsers(context.Background(), mcp.ListUsersInput{Limit: 25})
	if out.Users[0].Plan != "" || out.Users[0].OnMailingList != nil || len(out.Warnings) != 2 {
		t.Fatalf("unknowns reported as known: %+v %v", out.Users[0], out.Warnings)
	}
}

func TestListPayingUsersStatusFilter(t *testing.T) {
	store := &fakePeopleStore{}
	src := &adminMCPSource{people: store}
	for status, want := range map[string][]string{"paying": {"active", "trialing"}, "all": nil, "past_due": {"past_due"}} {
		if _, err := src.ListPayingUsers(context.Background(), mcp.ListPayingUsersInput{Status: status, Limit: 25}); err != nil {
			t.Fatal(err)
		}
		if len(store.statuses) != len(want) || (len(want) > 0 && store.statuses[0] != want[0]) {
			t.Fatalf("%s -> %v", status, store.statuses)
		}
	}
}

func TestLookupPersonFindsPlanByAccount(t *testing.T) {
	src := &adminMCPSource{people: &fakePeopleStore{}, users: fakeFirebaseUsers{}}
	out, err := src.LookupPerson(context.Background(), mcp.LookupPersonInput{Email: "paid@example.com"})
	if err != nil {
		t.Fatal(err)
	}
	// The subscription row carries the checkout email, not this one; it is
	// found through the account's uid.
	if out.Account == nil || out.Subscription == nil || out.Account.Plan != "premium (active)" {
		t.Fatalf("lookup = %+v", out)
	}
	if out.MailingList != nil || out.Account.OnMailingList == nil || *out.Account.OnMailingList {
		t.Fatalf("mailing list = %+v", out)
	}

	out, _ = src.LookupPerson(context.Background(), mcp.LookupPersonInput{Email: "news@example.com"})
	if out.Account != nil || out.MailingList == nil || out.MailingList.SubscribedAt != "2026-01-02T03:04:05Z" {
		t.Fatalf("lookup = %+v", out)
	}

	src.users = nil
	out, _ = src.LookupPerson(context.Background(), mcp.LookupPersonInput{Email: "paid@example.com"})
	if out.Account != nil || len(out.Warnings) != 1 {
		t.Fatalf("missing accounts source not named: %+v", out)
	}
}
