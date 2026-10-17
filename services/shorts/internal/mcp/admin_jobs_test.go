package mcp

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/castlemilk/shorted.com.au/services/shorts/internal/jobmonitor"
)

func (f *fakePublisher) AsyncJobs(context.Context) (*AsyncJobsOutput, error) {
	return &AsyncJobsOutput{Jobs: []jobmonitor.JobStatus{{Name: "shorted-picks", DisplayName: "Stock picks", Type: "job", Region: "us-central1", Health: jobmonitor.HealthWarning, RunningExecution: "shorted-picks-abc"}, {Name: "housing-crawl-delta", Type: "rig", Health: jobmonitor.HealthWarning}}, Warnings: []string{}, Sources: []JobSource{{Name: "test", Status: "available"}}}, nil
}
func (f *fakePublisher) ListJobExecutions(context.Context, string, string, int, string) (*jobmonitor.ExecutionPage, error) {
	return &jobmonitor.ExecutionPage{Executions: []jobmonitor.ExecutionSummary{{ExecutionName: "shorted-picks-abc", Status: "running"}}, NextPageToken: "page2"}, nil
}
func (f *fakePublisher) GetJobExecution(context.Context, string, string, string) (*jobmonitor.ExecutionSummary, error) {
	return &jobmonitor.ExecutionSummary{ExecutionName: "shorted-picks-abc", Status: "running", TaskCount: 2, RunningCount: 1}, nil
}
func (f *fakePublisher) EnrichmentJobs(context.Context, EnrichmentJobsInput) (*EnrichmentJobsOutput, error) {
	return &EnrichmentJobsOutput{Jobs: []EnrichmentJob{{ID: "abc", StockCode: "BHP", Status: "processing"}}, Total: 1}, nil
}

func TestAdminObservationRequiresReadScope(t *testing.T) {
	calls := []string{
		`{"name":"list_async_jobs","arguments":{}}`,
		`{"name":"list_job_executions","arguments":{"job":"shorted-picks"}}`,
		`{"name":"get_job_execution","arguments":{"job":"shorted-picks","execution_name":"shorted-picks-abc"}}`,
		`{"name":"list_enrichment_jobs","arguments":{"status":"processing"}}`,
		`{"name":"search_job_mentions","arguments":{"query":"picks"}}`,
	}
	for _, scopes := range [][]string{{ScopeNewsPublish}, {ScopeJobsRun}, {ScopeJobsRead}} {
		claims := adminClaims()
		claims.Scopes = scopes
		srv := adminStack(t, stubClaims{claims: claims}, onlyAdmin("uid-admin"), &fakePublisher{})
		for _, params := range calls {
			resp, body := adminCall(t, srv, "token", `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":`+params+`}`)
			if resp.StatusCode != http.StatusOK {
				t.Fatalf("%d %s", resp.StatusCode, body)
			}
			denied := strings.Contains(body, `"isError":true`)
			if denied != (scopes[0] != ScopeJobsRead) {
				t.Fatalf("scope %v params %s body %s", scopes, params, body)
			}
		}
		if scopes[0] == ScopeJobsRead {
			_, body := adminCall(t, srv, "token", runPicksCall)
			if !strings.Contains(body, `"isError":true`) {
				t.Fatalf("read scope started job: %s", body)
			}
		}
	}
}
func TestAsyncJobsFilterAndEntrypoint(t *testing.T) {
	srv := adminStack(t, stubClaims{claims: adminClaims()}, onlyAdmin("uid-admin"), &fakePublisher{})
	_, body := adminCall(t, srv, "token", `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_async_jobs","arguments":{"status":"running"}}}`)
	if !strings.Contains(body, "shorted-picks") || strings.Contains(body, "housing-crawl-delta") {
		t.Fatal(body)
	}
	_, body = adminCall(t, srv, "token", `{"jsonrpc":"2.0","id":2,"method":"tools/list"}`)
	if !strings.Contains(body, `"entrypoints":[{"type":"global"},{"type":"thread"}]`) || !strings.Contains(body, adminAppURI) {
		t.Fatal(body)
	}
}
func TestAdminResourceScopeAndPublicIsolation(t *testing.T) {
	for _, scope := range []string{ScopeJobsRead, ScopeNewsPublish} {
		c := adminClaims()
		c.Scopes = []string{scope}
		srv := adminStack(t, stubClaims{claims: c}, onlyAdmin("uid-admin"), &fakePublisher{})
		_, body := adminCall(t, srv, "token", `{"jsonrpc":"2.0","id":1,"method":"resources/read","params":{"uri":"shorted-admin://jobs/us-central1/shorted-picks"}}`)
		if strings.HasPrefix(body, "event:") {
			for _, line := range strings.Split(body, "\n") {
				if strings.HasPrefix(line, "data:") {
					body = strings.TrimSpace(strings.TrimPrefix(line, "data:"))
					break
				}
			}
		}
		var wire map[string]json.RawMessage
		if err := json.Unmarshal([]byte(body), &wire); err != nil {
			t.Fatal(err, body)
		}
		if scope == ScopeJobsRead && !strings.Contains(body, `"cacheScope":"private"`) {
			t.Fatal("admin resource must not be publicly cacheable", body)
		}
		if (wire["error"] != nil) != (scope != ScopeJobsRead) {
			t.Fatal(scope, body)
		}
	}
}
