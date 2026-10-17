package mcp

import (
	"context"
	"net/http"
	"strings"
	"testing"
)

// The fake records the last normalised input each tool handed the reader.
type peopleCalls struct {
	users   ListUsersInput
	paying  ListPayingUsersInput
	mailing ListMailingListInput
	lookup  LookupPersonInput
}

var lastPeople peopleCalls

func (f *fakePublisher) PeopleOverview(context.Context) (*PeopleOverviewOutput, error) {
	return &PeopleOverviewOutput{
		ObservedAt:  "2026-10-15T00:00:00Z",
		Users:       &UserCounts{Total: 12, EmailVerified: 10, ByProvider: map[string]int{"google.com": 9}},
		Paying:      &PayingCounts{Paying: 2, ByStatus: map[string]int{"active": 2}, PayingByTier: map[string]int{"premium": 2}},
		MailingList: nil, // unavailable, and said so
		Sources:     []JobSource{{Name: "mailing_list", Status: "unavailable"}},
		Warnings:    []string{"Mailing list counts could not be read."},
	}, nil
}
func (f *fakePublisher) ListUsers(_ context.Context, in ListUsersInput) (*ListUsersOutput, error) {
	lastPeople.users = in
	on := true
	return &ListUsersOutput{Users: []UserRow{{UserID: "uid-1", Email: "a@example.com", Providers: []string{"password"}, Plan: "free", OnMailingList: &on}}, Total: 30, NextOffset: NextOffset(in.Offset, 1, 30)}, nil
}
func (f *fakePublisher) ListPayingUsers(_ context.Context, in ListPayingUsersInput) (*ListPayingUsersOutput, error) {
	lastPeople.paying = in
	return &ListPayingUsersOutput{Subscriptions: []PayingUserRow{{UserID: "uid-2", Email: "b@example.com", Tier: "premium", Status: "active"}}, Total: 1}, nil
}
func (f *fakePublisher) ListMailingList(_ context.Context, in ListMailingListInput) (*ListMailingListOutput, error) {
	lastPeople.mailing = in
	return &ListMailingListOutput{Subscribers: []MailingListRow{{Email: "c@example.com"}}, Total: 1}, nil
}
func (f *fakePublisher) LookupPerson(_ context.Context, in LookupPersonInput) (*LookupPersonOutput, error) {
	lastPeople.lookup = in
	return &LookupPersonOutput{Email: in.Email}, nil
}

var peopleToolCalls = []string{
	`{"name":"people_overview","arguments":{}}`,
	`{"name":"list_users","arguments":{}}`,
	`{"name":"list_paying_users","arguments":{}}`,
	`{"name":"list_mailing_list","arguments":{}}`,
	`{"name":"lookup_person","arguments":{"email":"a@example.com"}}`,
}

func peopleCall(t *testing.T, scopes []string, params string) string {
	t.Helper()
	claims := adminClaims()
	if scopes != nil {
		claims.Scopes = scopes
	}
	srv := adminStack(t, stubClaims{claims: claims}, onlyAdmin("uid-admin"), &fakePublisher{})
	resp, body := adminCall(t, srv, "token", `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":`+params+`}`)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("%d %s", resp.StatusCode, body)
	}
	return body
}

// Personal data is behind users:read alone. jobs:read (monitoring) and the
// write scopes must not reach it, and users:read must not reach the job tools.
func TestPeopleToolsRequireUsersRead(t *testing.T) {
	for _, scope := range AdminScopes {
		for _, params := range peopleToolCalls {
			body := peopleCall(t, []string{scope}, params)
			denied := strings.Contains(body, `"isError":true`)
			if denied != (scope != ScopeUsersRead) {
				t.Fatalf("scope %s params %s: %s", scope, params, body)
			}
			if denied && !strings.Contains(body, "users:read") {
				t.Fatalf("refusal does not name the missing scope: %s", body)
			}
		}
	}
	body := peopleCall(t, []string{ScopeUsersRead}, `{"name":"list_async_jobs","arguments":{}}`)
	if !strings.Contains(body, `"isError":true`) {
		t.Fatalf("users:read reached the job fleet: %s", body)
	}
}

func TestPeopleToolsNormaliseInputs(t *testing.T) {
	lastPeople = peopleCalls{}
	peopleCall(t, nil, `{"name":"list_users","arguments":{"query":"  Example.COM "}}`)
	if got := lastPeople.users; got.Limit != 25 || got.Offset != 0 || got.Sort != "newest" || got.Query != "example.com" {
		t.Fatalf("list_users input = %+v", got)
	}
	peopleCall(t, nil, `{"name":"list_paying_users","arguments":{"limit":5,"offset":10}}`)
	if got := lastPeople.paying; got.Status != "paying" || got.Limit != 5 || got.Offset != 10 {
		t.Fatalf("list_paying_users input = %+v", got)
	}
	peopleCall(t, nil, `{"name":"list_mailing_list","arguments":{}}`)
	if got := lastPeople.mailing; got.Status != "subscribed" || got.Limit != 25 {
		t.Fatalf("list_mailing_list input = %+v", got)
	}
	peopleCall(t, nil, `{"name":"lookup_person","arguments":{"email":" Ben@Example.com "}}`)
	if got := lastPeople.lookup.Email; got != "ben@example.com" {
		t.Fatalf("lookup_person email = %q", got)
	}
}

func TestPeopleToolsRejectBadInputs(t *testing.T) {
	for _, params := range []string{
		`{"name":"list_users","arguments":{"limit":101}}`,
		`{"name":"list_users","arguments":{"offset":-1}}`,
		`{"name":"list_users","arguments":{"sort":"email"}}`,
		`{"name":"list_users","arguments":{"query":"` + strings.Repeat("a", 201) + `"}}`,
		`{"name":"list_paying_users","arguments":{"status":"rich"}}`,
		`{"name":"list_mailing_list","arguments":{"status":"bounced"}}`,
		`{"name":"lookup_person","arguments":{"email":"not-an-email"}}`,
		`{"name":"lookup_person","arguments":{"email":"Ben <ben@example.com>"}}`,
		`{"name":"lookup_person","arguments":{"email":"a@example.com, b@example.com"}}`,
	} {
		if body := peopleCall(t, nil, params); !strings.Contains(body, `"isError":true`) {
			t.Errorf("accepted %s: %s", params, body)
		}
	}
}

// An unavailable source is omitted and named, never reported as zero.
func TestPeopleOverviewKeepsUnknownsUnknown(t *testing.T) {
	body := peopleCall(t, nil, peopleToolCalls[0])
	if strings.Contains(body, `"mailingList"`) || !strings.Contains(body, "Mailing list counts could not be read") {
		t.Fatalf("overview = %s", body)
	}
	if !strings.Contains(body, `"paying":2`) || !strings.Contains(body, `"total":12`) {
		t.Fatalf("overview = %s", body)
	}
}

func TestPeopleToolsAreReadOnlyAndPaginated(t *testing.T) {
	srv := adminStack(t, stubClaims{claims: adminClaims()}, onlyAdmin("uid-admin"), &fakePublisher{})
	_, body := adminCall(t, srv, "token", `{"jsonrpc":"2.0","id":1,"method":"tools/list"}`)
	for _, name := range []string{"people_overview", "list_users", "list_paying_users", "list_mailing_list", "lookup_person"} {
		if !strings.Contains(body, `"name":"`+name+`"`) {
			t.Fatalf("%s not listed", name)
		}
	}
	body = peopleCall(t, nil, `{"name":"list_users","arguments":{"offset":3}}`)
	if !strings.Contains(body, `"nextOffset":4`) {
		t.Fatalf("list_users page = %s", body)
	}
}

func TestNextOffset(t *testing.T) {
	if NextOffset(0, 25, 25) != nil || NextOffset(0, 0, 10) != nil {
		t.Fatal("NextOffset past the end")
	}
	if n := NextOffset(25, 25, 60); n == nil || *n != 50 {
		t.Fatalf("NextOffset = %v", n)
	}
}
