package mcp

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

// fakeAlertsOp records what the alerts tools asked for. It sits inside
// fakePublisher (admin_test.go), so the socket harness serves it unchanged.
type fakeAlertsOp struct {
	uidSeen    []string
	actorSeen  string
	smokeIn    RunAlertsSmokeInput
	smokeOut   *RunAlertsSmokeOutput
	smokeErr   error
	findIn     FindAlertCrossingInput
	resultIn   AlertsSmokeResultInput
	deleteID   string
	deleteErr  error
	statusSeen bool
}

func (f *fakeAlertsOp) AlertsStatus(_ context.Context, uid string) (*AlertsStatusOutput, error) {
	f.uidSeen = append(f.uidSeen, uid)
	f.statusSeen = true
	return &AlertsStatusOutput{ObservedAt: "2026-10-24T00:00:00Z", Monitors: []AlertMonitorCount{}, Mine: []AlertsOwnMonitor{}}, nil
}

func (f *fakeAlertsOp) FindAlertCrossing(_ context.Context, in FindAlertCrossingInput) (*FindAlertCrossingOutput, error) {
	f.findIn = in
	return &FindAlertCrossingOutput{Found: false, Threshold: AlertsDefaultThreshold, Condition: AlertsCondition}, nil
}

func (f *fakeAlertsOp) RunAlertsSmoke(_ context.Context, uid, actor string, in RunAlertsSmokeInput) (*RunAlertsSmokeOutput, error) {
	f.uidSeen = append(f.uidSeen, uid)
	f.actorSeen = actor
	f.smokeIn = in
	if f.smokeErr != nil {
		return nil, f.smokeErr
	}
	if f.smokeOut != nil {
		return f.smokeOut, nil
	}
	return &RunAlertsSmokeOutput{
		MonitorID: "7d2c4f1e-0a9b-4c3d-8e2f-1a2b3c4d5e6f", MonitorState: "created", Code: "ABC", Date: "2026-10-21",
		ComparedToDate: "2026-10-20", Previous: 4, Latest: 5.5, Threshold: 5, Condition: "above",
		EmailTo: MaskAlertEmail("ben@shorted.com.au"), Execution: "shorted-alerts-replay-ab12c",
		Args: []string{"alerts", "-date", "2026-10-21", "-user", uid, "-canary", "off"},
	}, nil
}

func (f *fakeAlertsOp) AlertsSmokeResult(_ context.Context, uid string, in AlertsSmokeResultInput) (*AlertsSmokeResultOutput, error) {
	f.uidSeen = append(f.uidSeen, uid)
	f.resultIn = in
	return &AlertsSmokeResultOutput{MonitorID: in.MonitorID, Date: in.Date, Events: []AlertsSmokeEvent{{EmailStatus: "sent", HasResendID: true}}}, nil
}

func (f *fakeAlertsOp) DeleteOwnAlertMonitor(_ context.Context, uid, monitorID string) error {
	f.uidSeen = append(f.uidSeen, uid)
	f.deleteID = monitorID
	return f.deleteErr
}

const alertsMonitorID = "7d2c4f1e-0a9b-4c3d-8e2f-1a2b3c4d5e6f"

func alertsCall(id int, name, args string) string {
	return `{"jsonrpc":"2.0","id":` + strconv.Itoa(id) + `,"method":"tools/call","params":{"name":"` + name + `","arguments":` + args + `}}`
}

// Every alerts tool refuses a token that lacks its own scope, and says which scope
// it needs. The refusal is a tool error, not a connection error.
func TestAlertsToolsRequireTheirOwnScope(t *testing.T) {
	cases := []struct {
		tool, args, scope string
		only              []string
	}{
		{AlertsStatusTool, `{}`, ScopeJobsRead, []string{ScopeJobsRun}},
		{FindAlertCrossingTool, `{}`, ScopeJobsRead, []string{ScopeNewsPublish}},
		{RunAlertsSmokeTool, `{}`, ScopeJobsRun, []string{ScopeJobsRead}},
		{AlertsSmokeResultTool, `{"monitor_id":"` + alertsMonitorID + `","date":"2026-10-21"}`, ScopeJobsRead, []string{ScopeJobsRun}},
		{DeleteAlertMonitorTool, `{"monitor_id":"` + alertsMonitorID + `"}`, ScopeJobsRun, []string{ScopeJobsRead}},
	}
	for _, c := range cases {
		claims := adminClaims()
		claims.Scopes = c.only
		pub := &fakePublisher{}
		srv := adminStack(t, stubClaims{claims: claims}, onlyAdmin("uid-admin"), pub)
		resp, body := adminCall(t, srv, "t", alertsCall(1, c.tool, c.args))
		if resp.StatusCode != http.StatusOK || !strings.Contains(body, `"isError":true`) || !strings.Contains(body, c.scope) {
			t.Fatalf("%s: status=%d body=%s; want a tool error naming %s", c.tool, resp.StatusCode, body, c.scope)
		}
		if len(pub.uidSeen) != 0 || pub.smokeIn.Code != "" || pub.deleteID != "" || pub.statusSeen {
			t.Fatalf("%s reached the operator without its scope", c.tool)
		}
	}
}

// The owner is the verified token's uid. Every alerts tool is driven with valid
// input only, so each call reaches the operator, and every owner the operator sees is
// the token's. The assertions cover the calls that happened: a loop over nothing
// proves nothing.
func TestAlertsOwnerIsAlwaysTheTokenUser(t *testing.T) {
	pub := &fakePublisher{}
	srv := adminStack(t, stubClaims{claims: adminClaims()}, onlyAdmin("uid-admin"), pub)
	calls := []string{
		alertsCall(1, RunAlertsSmokeTool, `{"code":"ABC"}`),
		alertsCall(2, DeleteAlertMonitorTool, `{"monitor_id":"`+alertsMonitorID+`"}`),
		alertsCall(3, AlertsStatusTool, `{}`),
		alertsCall(4, AlertsSmokeResultTool, `{"monitor_id":"`+alertsMonitorID+`","date":"2026-10-21"}`),
	}
	for _, call := range calls {
		resp, body := adminCall(t, srv, "t", call)
		require.Equal(t, http.StatusOK, resp.StatusCode)
		require.NotContains(t, body, `"isError":true`, "a valid call must reach the operator: %s", body)
	}
	require.Len(t, pub.uidSeen, len(calls), "every call must reach the operator")
	for _, uid := range pub.uidSeen {
		assert.Equal(t, "uid-admin", uid, "the operator acted for a user other than the token's")
	}
}

// An input that names another owner is refused by the schema before the operator runs.
// The tool takes no owner field, so nothing can be sent that the operator would read.
func TestAlertsRefusesAnOwnerFieldInTheInput(t *testing.T) {
	for _, call := range []string{
		alertsCall(1, RunAlertsSmokeTool, `{"code":"ABC","user_id":"uid-victim"}`),
		alertsCall(2, RunAlertsSmokeTool, `{"code":"ABC","uid":"uid-victim"}`),
		alertsCall(3, DeleteAlertMonitorTool, `{"monitor_id":"`+alertsMonitorID+`","user_id":"uid-victim"}`),
		alertsCall(4, AlertsStatusTool, `{"user_id":"uid-victim"}`),
	} {
		pub := &fakePublisher{}
		srv := adminStack(t, stubClaims{claims: adminClaims()}, onlyAdmin("uid-admin"), pub)
		resp, body := adminCall(t, srv, "t", call)
		assert.Equal(t, http.StatusOK, resp.StatusCode)
		assert.Contains(t, body, `"isError":true`, "an owner field must be refused: %s", body)
		assert.Empty(t, pub.uidSeen, "a refused call must not reach the operator")
	}
}

// Ids are trimmed before they are validated, and the trimmed value is what the operator
// receives, so the validated value and the used value are the same.
func TestAlertsIdsAreTrimmedBeforeTheyAreUsed(t *testing.T) {
	pub := &fakePublisher{}
	srv := adminStack(t, stubClaims{claims: adminClaims()}, onlyAdmin("uid-admin"), pub)
	padded := "  " + alertsMonitorID + " "
	adminCall(t, srv, "t", alertsCall(1, AlertsSmokeResultTool, `{"monitor_id":"`+padded+`","date":"2026-10-21"}`))
	assert.Equal(t, alertsMonitorID, pub.resultIn.MonitorID, "the operator must receive the trimmed id")
	adminCall(t, srv, "t", alertsCall(2, DeleteAlertMonitorTool, `{"monitor_id":"`+padded+`"}`))
	assert.Equal(t, alertsMonitorID, pub.deleteID, "delete must use the trimmed id")
}

// Input is checked before the operator is asked: a bad date, a missing code for a
// date, an out-of-range threshold and a below search are all refused up front.
func TestRunAlertsSmokeRefusesBadInputBeforeTheOperator(t *testing.T) {
	bad := []string{
		`{"code":"ABC","date":"2026-1-5"}`,
		`{"code":"ABC","date":"2099-01-01"}`,
		`{"date":"2026-10-21"}`,
		`{"code":"ABC","threshold":0}`,
		`{"code":"ABC","threshold":101}`,
		`{"code":"ABC","condition":"below"}`,
		`{"code":"B-H"}`,
	}
	for _, args := range bad {
		pub := &fakePublisher{}
		srv := adminStack(t, stubClaims{claims: adminClaims()}, onlyAdmin("uid-admin"), pub)
		resp, body := adminCall(t, srv, "t", alertsCall(1, RunAlertsSmokeTool, args))
		if resp.StatusCode != http.StatusOK || !strings.Contains(body, `"isError":true`) {
			t.Fatalf("%s: status=%d body=%s; want a tool error", args, resp.StatusCode, body)
		}
		if len(pub.uidSeen) != 0 {
			t.Fatalf("%s reached the operator", args)
		}
	}
}

func TestRunAlertsSmokeReturnsTheMaskedAddressAndTheExecution(t *testing.T) {
	pub := &fakePublisher{}
	srv := adminStack(t, stubClaims{claims: adminClaims()}, onlyAdmin("uid-admin"), pub)
	resp, body := adminCall(t, srv, "t", alertsCall(1, RunAlertsSmokeTool, `{"code":"ABC","date":"2026-10-21"}`))
	if resp.StatusCode != http.StatusOK || strings.Contains(body, `"isError":true`) {
		t.Fatalf("status=%d body=%s", resp.StatusCode, body)
	}
	if pub.smokeIn.Code != "ABC" || pub.smokeIn.Date != "2026-10-21" {
		t.Fatalf("operator input = %+v", pub.smokeIn)
	}
	if pub.actorSeen != "oauth:uid-admin" {
		t.Fatalf("actor = %q, want the token's identity", pub.actorSeen)
	}
	if !strings.Contains(body, "b***@shorted.com.au") {
		t.Fatalf("response must carry the masked address: %s", body)
	}
	if strings.Contains(body, "ben@shorted.com.au") {
		t.Fatalf("response leaked the full address: %s", body)
	}
	if !strings.Contains(body, "shorted-alerts-replay-ab12c") {
		t.Fatalf("response lacks the execution name: %s", body)
	}
}

func TestRunAlertsSmokeOperatorRefusalIsAToolError(t *testing.T) {
	pub := &fakePublisher{}
	pub.smokeErr = errors.New("this admin account has no active Premium subscription")
	srv := adminStack(t, stubClaims{claims: adminClaims()}, onlyAdmin("uid-admin"), pub)
	resp, body := adminCall(t, srv, "t", alertsCall(1, RunAlertsSmokeTool, `{}`))
	if resp.StatusCode != http.StatusOK || !strings.Contains(body, `"isError":true`) || !strings.Contains(body, "Premium") {
		t.Fatalf("status=%d body=%s; want a tool error with the entitlement message", resp.StatusCode, body)
	}
}

func TestFindAlertCrossingRefusesBelowAndBadCodes(t *testing.T) {
	for _, args := range []string{`{"condition":"below"}`, `{"code":"abc-def"}`, `{"threshold":-1}`} {
		pub := &fakePublisher{}
		srv := adminStack(t, stubClaims{claims: adminClaims()}, onlyAdmin("uid-admin"), pub)
		resp, body := adminCall(t, srv, "t", alertsCall(1, FindAlertCrossingTool, args))
		if resp.StatusCode != http.StatusOK || !strings.Contains(body, `"isError":true`) {
			t.Fatalf("%s: status=%d body=%s; want a tool error", args, resp.StatusCode, body)
		}
		if pub.findIn.Code != "" {
			t.Fatalf("%s reached the operator", args)
		}
	}
	pub := &fakePublisher{}
	srv := adminStack(t, stubClaims{claims: adminClaims()}, onlyAdmin("uid-admin"), pub)
	adminCall(t, srv, "t", alertsCall(1, FindAlertCrossingTool, `{"code":"bhp"}`))
	if pub.findIn.Code != "bhp" {
		// The tool validates the case-folded code and passes the caller's text on;
		// the store upper-cases it. Nothing is repaired silently here.
		t.Fatalf("find input = %+v", pub.findIn)
	}
}

func TestAlertsSmokeResultAndDeleteRefuseMalformedIDs(t *testing.T) {
	pub := &fakePublisher{}
	srv := adminStack(t, stubClaims{claims: adminClaims()}, onlyAdmin("uid-admin"), pub)
	for _, call := range []string{
		alertsCall(1, AlertsSmokeResultTool, `{"monitor_id":"x","date":"2026-10-21"}`),
		alertsCall(2, AlertsSmokeResultTool, `{"monitor_id":"`+alertsMonitorID+`","date":"yesterday"}`),
		alertsCall(3, DeleteAlertMonitorTool, `{"monitor_id":"../../x"}`),
	} {
		resp, body := adminCall(t, srv, "t", call)
		if resp.StatusCode != http.StatusOK || !strings.Contains(body, `"isError":true`) {
			t.Fatalf("status=%d body=%s; want a tool error", resp.StatusCode, body)
		}
	}
	if pub.resultIn.MonitorID != "" || pub.deleteID != "" {
		t.Fatal("a malformed id reached the operator")
	}
}

func TestAlertsToolsAreAnnotatedHonestly(t *testing.T) {
	registered := map[string]bool{}
	for _, at := range AdminRegistry() {
		registered[at.Name] = true
	}
	for _, name := range []string{AlertsStatusTool, FindAlertCrossingTool, AlertsSmokeResultTool, RunAlertsSmokeTool, DeleteAlertMonitorTool} {
		if !registered[name] {
			t.Fatalf("%s is not in AdminRegistry", name)
		}
	}
	for _, name := range []string{AlertsStatusTool, FindAlertCrossingTool, AlertsSmokeResultTool} {
		if !readOnlyHint(t, name) {
			t.Errorf("%s must be annotated read-only", name)
		}
	}
	for _, name := range []string{RunAlertsSmokeTool, DeleteAlertMonitorTool} {
		if readOnlyHint(t, name) {
			t.Errorf("%s writes and must not be annotated read-only", name)
		}
	}
}

// readOnlyHint lists the admin server's tools and reads one's annotation.
func readOnlyHint(t *testing.T, name string) bool {
	t.Helper()
	server := NewAdminServer(&fakePublisher{})
	ct, st := sdk.NewInMemoryTransports()
	ctx := context.Background()
	if _, err := server.Connect(ctx, st, nil); err != nil {
		t.Fatal(err)
	}
	client := sdk.NewClient(&sdk.Implementation{Name: "t", Version: "0"}, nil)
	session, err := client.Connect(ctx, ct, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = session.Close() }()
	res, err := session.ListTools(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, tool := range res.Tools {
		if tool.Name == name {
			return tool.Annotations != nil && tool.Annotations.ReadOnlyHint
		}
	}
	t.Fatalf("tool %s not listed", name)
	return false
}

func TestMaskAlertEmailShowsOnlyTheFirstLetterAndDomain(t *testing.T) {
	cases := map[string]string{
		"ben@shorted.com.au": "b***@shorted.com.au",
		"a@x.io":             "a***@x.io",
		"noat":               "***",
		"@nolocal.com":       "***",
	}
	for in, want := range cases {
		if got := MaskAlertEmail(in); got != want {
			t.Errorf("MaskAlertEmail(%q) = %q, want %q", in, got, want)
		}
	}
}

// A token whose uid carries surrounding space is refused. The check would accept it
// (this one accepts everything), so the refusal can only come from the padding.
func TestRequireAdminRefusesAPaddedUID(t *testing.T) {
	accept := func(context.Context, string) (bool, error) { return true, nil }
	for _, uid := range []string{" uid-admin", "uid-admin ", "uid-admin\n"} {
		claims := adminClaims()
		claims.UserID = uid
		pub := &fakePublisher{}
		srv := adminStack(t, stubClaims{claims: claims}, accept, pub)
		resp, _ := adminCall(t, srv, "t", alertsCall(1, AlertsStatusTool, `{}`))
		assert.Equal(t, http.StatusForbidden, resp.StatusCode, "uid %q", uid)
		assert.Empty(t, pub.uidSeen, "uid %q reached the operator", uid)
	}
}
