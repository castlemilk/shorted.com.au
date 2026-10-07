package mcp

// admin.go is a SECOND MCP server, mounted at /mcp/admin, for the handful of
// write operations an administrator drives from an agent — publishing a merged
// content/news article, and running the stock picker's data job on demand.
//
// It is deliberately NOT a set of extra tools on the public server:
//
//   - The public server's promise is read-only and anonymous-first. Every tool
//     there carries ReadOnlyHint, calls a VISIBILITY_PUBLIC RPC in process, and
//     is listed in the public catalog (TestToolsOnlyCallPublicMethods,
//     TestNoScopeEncodesASubscriptionTier). A write tool would break all three.
//   - It is a separate OAuth RESOURCE. A token's audience is exactly one
//     resource, so a token issued for /mcp is refused here and a token issued
//     for /mcp/admin is refused on /mcp (NewTokenVerifier's exact audience
//     match). Granting the public server never grants this one.
//   - Its scopes, news:publish and jobs:run, are not in Scopes. The public
//     vocabulary is "every scope ends in :read", and an empty scope request on
//     /mcp is granted the whole public vocabulary — keeping the admin scopes
//     out of it is what stops an ordinary grant from carrying them by default.
//
// Scopes here name admin actions (including operational reads), and each tool checks its own
// (requireScope). The HTTP layer requires a verified admin token carrying at
// least one admin scope; it does not require all of them, so a connector
// authorised before a scope existed keeps working for the tools it was granted
// and is told, per tool, to reconnect for the new one — rather than being
// logged out wholesale by a 403 on every call.
//
// Who may use it is decided THREE times, on purpose: the authorization server
// refuses to grant this resource to a non-admin (ticket, grant, token AND
// refresh — oauth.Entitlement), and the HTTP middleware re-checks admin status
// on every request (RequireAdmin), so removing someone from the allowlist takes
// effect on their next call rather than when their 30-day refresh family dies.

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"strings"

	"github.com/modelcontextprotocol/go-sdk/auth"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/modelcontextprotocol/go-sdk/oauthex"

	"github.com/castlemilk/shorted.com.au/services/shorts/internal/jobmonitor"
)

// AdminServerName identifies the admin server to clients. Distinct from
// ServerName so a client holding both connections can tell them apart.
const (
	AdminServerName  = "shorted-admin"
	AdminServerTitle = "Shorted — admin (publishing, data jobs)"
)

// The admin scope vocabulary. Kept apart from Scopes — see the file header.
const (
	// ScopeNewsPublish covers publish_news_article and news_publish_status.
	ScopeNewsPublish = "news:publish"
	// ScopeJobsRun covers run_picks_job and picks_job_status: starting an
	// on-demand execution of a data job the server chooses, with arguments the
	// server builds.
	ScopeJobsRun = "jobs:run"
	// ScopeJobsRead observes the fleet without permission to start jobs.
	ScopeJobsRead = "jobs:read"
)

// AdminScopes is the admin resource's entire scope vocabulary, in published
// order. An empty scope request against /mcp/admin is granted all of it.
var AdminScopes = []string{ScopeNewsPublish, ScopeJobsRun, ScopeJobsRead}

// AdminProtectedResourceMetadataPath is RFC 9728 §3.1's location for a
// resource whose identifier has the path /mcp/admin.
const AdminProtectedResourceMetadataPath = "/.well-known/oauth-protected-resource/mcp/admin"

// AdminResourceURI returns the RFC 8707 resource identifier of the admin server.
func AdminResourceURI(apiBaseURL string) string {
	return strings.TrimSuffix(apiBaseURL, "/") + "/mcp/admin"
}

// AdminProtectedResourceMetadataURL is the absolute URL of the admin metadata
// document, as it appears in the admin WWW-Authenticate challenge.
func AdminProtectedResourceMetadataURL(apiBaseURL string) string {
	return strings.TrimSuffix(apiBaseURL, "/") + AdminProtectedResourceMetadataPath
}

// AdminProtectedResourceMetadata builds the RFC 9728 document for /mcp/admin.
func AdminProtectedResourceMetadata(apiBaseURL string) *oauthex.ProtectedResourceMetadata {
	base := strings.TrimSuffix(apiBaseURL, "/")
	return &oauthex.ProtectedResourceMetadata{
		Resource:               AdminResourceURI(base),
		AuthorizationServers:   []string{base},
		ScopesSupported:        append([]string(nil), AdminScopes...),
		BearerMethodsSupported: []string{"header"},
		ResourceName:           AdminServerTitle,
		ResourceDocumentation:  DocumentationURL,
	}
}

// AdminProtectedResourceMetadataHandler serves the admin metadata document.
func AdminProtectedResourceMetadataHandler(apiBaseURL string) http.Handler {
	return auth.ProtectedResourceMetadataHandler(AdminProtectedResourceMetadata(apiBaseURL))
}

// AdminBearerTokenOptions REQUIRE a token. Unlike the public server there is no
// anonymous path: an unauthenticated request gets the 401 + RFC 9728 challenge
// that starts a client's OAuth flow.
//
// Scopes is deliberately EMPTY here: the SDK treats that list as "all of these
// must be present", which would refuse every token minted before a scope was
// added to the vocabulary. The scope check is RequireAdmin's (at least one
// admin scope) and each tool's (its own scope) instead.
func AdminBearerTokenOptions(apiBaseURL string) *auth.RequireBearerTokenOptions {
	return &auth.RequireBearerTokenOptions{
		ResourceMetadataURL: AdminProtectedResourceMetadataURL(apiBaseURL),
		ClockSkew:           ClockSkew,
	}
}

// AdminCheck reports whether a user id is currently an administrator.
type AdminCheck func(ctx context.Context, userID string) (bool, error)

// RequireAdmin re-checks admin status on EVERY request, after the bearer token
// has been verified. It must be composed INSIDE auth.RequireBearerToken, which
// is what puts the TokenInfo it reads into the context.
//
// It also requires the token to carry at least one admin scope (403
// insufficient scope otherwise). A token bound to this resource's audience but
// granted none of its scopes should not exist — the AS grants a resource only
// its own vocabulary — so this is a belt for that brace.
//
// Fails closed, but says WHICH kind of closed. A definite "not an admin" (or no
// token info, or no check configured) is 403. A failed LOOKUP is 503 with
// Retry-After: the caller is quite possibly an admin and we could not ask.
// Answering that with 403 made a transient web-app hiccup look like an
// authorization failure, and a client treats an authorization failure by
// dropping its sign-in — an admin was logged out of the connector for a timeout
// on our side. Neither answer lets anyone through.
func RequireAdmin(check AdminCheck) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			info := auth.TokenInfoFromContext(r.Context())
			if check == nil || info == nil || strings.TrimSpace(info.UserID) == "" {
				http.Error(w, "forbidden: administrator access required", http.StatusForbidden)
				return
			}
			if !hasAnyScope(info.Scopes, AdminScopes) {
				http.Error(w, "insufficient scope", http.StatusForbidden)
				return
			}
			ok, err := check(r.Context(), info.UserID)
			if err != nil {
				w.Header().Set("Retry-After", "5")
				http.Error(w, "administrator check temporarily unavailable; retry shortly", http.StatusServiceUnavailable)
				return
			}
			if !ok {
				http.Error(w, "forbidden: administrator access required", http.StatusForbidden)
				return
			}
			w.Header().Set("Cache-Control", "private, no-store")
			next.ServeHTTP(w, r)
		})
	}
}

// hasAnyScope reports whether granted carries at least one of wanted.
func hasAnyScope(granted, wanted []string) bool {
	for _, w := range wanted {
		if slices.Contains(granted, w) {
			return true
		}
	}
	return false
}

// AdminOperator is the slice of the job monitor the admin tools drive. Narrow
// on purpose: writes are limited to publishing and picks; AdminReader exposes
// operational observations without granting any additional write capability.
// In particular it is NOT the fleet-wide RunJob.
type AdminOperator interface {
	AdminReader
	RunPublish(ctx context.Context, req jobmonitor.PublishRequest) (*jobmonitor.PublishRun, error)
	PublishResult(ctx context.Context, executionName string) (*jobmonitor.PublishStatus, error)
	RunPicks(ctx context.Context, req jobmonitor.PicksRequest) (*jobmonitor.PicksRun, error)
	PicksResult(ctx context.Context, executionName string) (*jobmonitor.ExecutionStatus, error)
}

// AdminTool is one admin tool. A separate type from Tool so the public
// registry's guards (public RPCs, read-only, catalog, payload budgets) never
// see it.
type AdminTool struct {
	Name string
	// Scope is the admin scope the tool requires (checked per call).
	Scope    string
	register func(*sdk.Server, AdminOperator)
}

// AdminRegistry is every tool on the admin server.
func AdminRegistry() []AdminTool {
	return []AdminTool{publishNewsArticleTool(), newsPublishStatusTool(), runPicksJobTool(), picksJobStatusTool(),
		listAsyncJobsTool(), listJobExecutionsTool(), getJobExecutionTool(), listEnrichmentJobsTool(), searchJobMentionsTool()}
}

// NewAdminServer builds the admin MCP server with operational tools, its app,
// and scope-protected job mention resources.
func NewAdminServer(pub AdminOperator) *sdk.Server {
	server := sdk.NewServer(&sdk.Implementation{
		Name: AdminServerName, Title: AdminServerTitle, Version: ServerVersion,
		WebsiteURL: WebsiteURL, Icons: Icons(),
	}, nil)
	// go-sdk v1.7.0 unconditionally resets resource CacheScope to "public"
	// after calling a resource handler. Apply the admin policy AFTER that
	// normalization; setting it only in the handler is silently overwritten.
	server.AddReceivingMiddleware(func(next sdk.MethodHandler) sdk.MethodHandler {
		return func(ctx context.Context, method string, req sdk.Request) (sdk.Result, error) {
			result, err := next(ctx, method, req)
			if resource, ok := result.(*sdk.ReadResourceResult); ok && resource != nil {
				resource.CacheScope = "private"
				resource.TTLMs = 0
			}
			return result, err
		}
	})
	registerAdminResources(server, pub)
	if pub != nil {
		for _, t := range AdminRegistry() {
			t.register(server, pub)
		}
	}
	return server
}

// AdminHandler serves the admin server over the same stateless streamable
// transport as the public one, for the same reasons (see Handler).
func AdminHandler(pub AdminOperator) http.Handler {
	server := NewAdminServer(pub)
	return boundStreamLifetime(StreamLifetime, sdk.NewStreamableHTTPHandler(func(*http.Request) *sdk.Server {
		return server
	}, &sdk.StreamableHTTPOptions{Stateless: true}))
}

// adminActor is the audit identity recorded for a tool call.
func adminActor(req *sdk.CallToolRequest) string {
	if req != nil && req.Extra != nil && req.Extra.TokenInfo != nil && req.Extra.TokenInfo.UserID != "" {
		return "oauth:" + req.Extra.TokenInfo.UserID
	}
	return "oauth:unknown"
}

func boolPtr(b bool) *bool { return &b }

// requireScope is the per-tool half of the scope check. A token without the
// tool's scope gets a tool-level error that says which scope is missing and
// how to get it, so an agent (and the person behind it) can act on it — a
// protocol-level 403 would instead make the client drop its sign-in for a
// connector that still works for everything else it was granted.
func requireScope(req *sdk.CallToolRequest, scope string) *sdk.CallToolResult {
	if req != nil && req.Extra != nil && req.Extra.TokenInfo != nil && slices.Contains(req.Extra.TokenInfo.Scopes, scope) {
		return nil
	}
	res := &sdk.CallToolResult{}
	res.SetError(fmt.Errorf("this connection was not granted the %s scope; disconnect and reconnect the Shorted admin connector to approve it", scope))
	return res
}

// --- publish_news_article ----------------------------------------------------

// PublishNewsArticleInput is the publish request. Note what is NOT here: no
// article body, no job name, no arguments. The article must already be merged
// to main; the job builds its argv from the slug alone.
type PublishNewsArticleInput struct {
	Slug   string `json:"slug" jsonschema:"The article's frontmatter slug, lowercase kebab-case, e.g. us-bond-rout-australia-banks-property-shorts. The article must be merged to main (content/news) and deployed."`
	Images *bool  `json:"images,omitempty" jsonschema:"Generate the hero and layout images (about A$0.50). Defaults to true; false publishes with the article's cover as the hero."`
	Force  bool   `json:"force,omitempty" jsonschema:"Start even if a publish is already running. Pays for images twice; leave false unless the running one is stuck."`
}

// PublishNewsArticleOutput describes the run that was started.
type PublishNewsArticleOutput struct {
	ExecutionName string   `json:"execution_name" jsonschema:"Pass to news_publish_status to follow the run."`
	Slug          string   `json:"slug"`
	URL           string   `json:"url" jsonschema:"Where the article will be live once the run succeeds."`
	Args          []string `json:"args" jsonschema:"The job invocation the server constructed."`
}

func publishNewsArticleTool() AdminTool {
	t := AdminTool{Name: "publish_news_article", Scope: ScopeNewsPublish}
	t.register = func(server *sdk.Server, pub AdminOperator) {
		sdk.AddTool(server, &sdk.Tool{
			Name:  t.Name,
			Title: "Publish a news article",
			Description: "Publish one hand-written article from content/news to https://shorted.com.au/news. " +
				"Starts the shorted-news-publish job, which loads the article, generates images, runs a vision check, " +
				"sets it live and refreshes /news. Takes several minutes: poll news_publish_status with the returned execution_name. " +
				"Only merged articles can be published; re-publishing an already-live article updates its content in place.",
			Annotations: &sdk.ToolAnnotations{
				ReadOnlyHint:    false,
				DestructiveHint: boolPtr(false),
				IdempotentHint:  true,
				OpenWorldHint:   boolPtr(false),
			},
		}, func(ctx context.Context, req *sdk.CallToolRequest, in PublishNewsArticleInput) (*sdk.CallToolResult, PublishNewsArticleOutput, error) {
			if denied := requireScope(req, t.Scope); denied != nil {
				return denied, PublishNewsArticleOutput{}, nil
			}
			run, err := pub.RunPublish(ctx, jobmonitor.PublishRequest{
				Slug:       in.Slug,
				SkipImages: in.Images != nil && !*in.Images,
				Force:      in.Force,
				Actor:      adminActor(req),
			})
			if err != nil {
				return adminToolError(err), PublishNewsArticleOutput{}, nil
			}
			out := PublishNewsArticleOutput{ExecutionName: run.ExecutionName, Slug: run.Slug, URL: run.URL, Args: run.Args}
			text := fmt.Sprintf("Started publishing %s (execution %s). It takes several minutes; check news_publish_status. It will be live at %s.",
				run.Slug, run.ExecutionName, run.URL)
			return &sdk.CallToolResult{Content: []sdk.Content{&sdk.TextContent{Text: text}}}, out, nil
		})
	}
	return t
}

// --- news_publish_status -----------------------------------------------------

// NewsPublishStatusInput names the run to poll.
type NewsPublishStatusInput struct {
	ExecutionName string `json:"execution_name" jsonschema:"The execution_name publish_news_article returned."`
}

// NewsPublishStatusOutput is the run's state.
type NewsPublishStatusOutput struct {
	ExecutionName string `json:"execution_name"`
	Status        string `json:"status" jsonschema:"running, succeeded, failed or unknown."`
	StartedAt     string `json:"started_at,omitempty"`
	CompletedAt   string `json:"completed_at,omitempty"`
	LogURI        string `json:"log_uri,omitempty" jsonschema:"Cloud Logging link for the run."`
	Message       string `json:"message,omitempty" jsonschema:"Why it failed, when it failed."`
}

func newsPublishStatusTool() AdminTool {
	t := AdminTool{Name: "news_publish_status", Scope: ScopeNewsPublish}
	t.register = func(server *sdk.Server, pub AdminOperator) {
		sdk.AddTool(server, &sdk.Tool{
			Name:        t.Name,
			Title:       "Check a news publish run",
			Description: "Report whether a publish_news_article run is still running, succeeded or failed, with its log link and failure reason.",
			Annotations: &sdk.ToolAnnotations{ReadOnlyHint: true, OpenWorldHint: boolPtr(false)},
		}, func(ctx context.Context, req *sdk.CallToolRequest, in NewsPublishStatusInput) (*sdk.CallToolResult, NewsPublishStatusOutput, error) {
			if denied := requireScope(req, t.Scope); denied != nil {
				return denied, NewsPublishStatusOutput{}, nil
			}
			st, err := pub.PublishResult(ctx, in.ExecutionName)
			if err != nil {
				return adminToolError(err), NewsPublishStatusOutput{}, nil
			}
			out := NewsPublishStatusOutput{
				ExecutionName: st.ExecutionName, Status: st.Status, StartedAt: st.StartedAt,
				CompletedAt: st.CompletedAt, LogURI: st.LogUri, Message: st.Message,
			}
			text := fmt.Sprintf("%s: %s", st.ExecutionName, st.Status)
			if st.Message != "" {
				text += " — " + st.Message
			}
			return &sdk.CallToolResult{Content: []sdk.Content{&sdk.TextContent{Text: text}}}, out, nil
		})
	}
	return t
}

// --- run_picks_job -----------------------------------------------------------

// RunPicksJobInput names a MODE and nothing else: no job, no region, no
// arguments, no code list. The server builds `picks -mode <mode>` from the
// closed enum (jobmonitor.NormalizePicksMode).
type RunPicksJobInput struct {
	Mode  string `json:"mode" jsonschema:"Which step to run: fundamentals (pull the full income statement, balance sheet and cash flow for every code in priority order, within a budget of about 170 minutes), filings (a deterministic, fail-closed rebuild of the rows parsed from ASX results filings: values that fail a check are withheld and filing rows the extractions no longer support are removed; seconds, no network), refresh (refresh_strategy_views: market regime, growth, quality ratios and price features, then revalidate the picks pages), or all (the three in order, what the nightly schedule runs)."`
	Force bool   `json:"force,omitempty" jsonschema:"Start even if a picks run is already in flight. The job's own lease still stops a second writer: fundamentals, filings or all exits without writing while another execution holds it (up to 4 hours, renewed as that run progresses). Leave false unless the running one is stuck."`
}

// RunPicksJobOutput describes the run that was started.
type RunPicksJobOutput struct {
	ExecutionName string   `json:"execution_name" jsonschema:"Pass to picks_job_status to follow the run."`
	Mode          string   `json:"mode"`
	Args          []string `json:"args" jsonschema:"The job invocation the server constructed."`
	Next          string   `json:"next,omitempty" jsonschema:"What to run after this one succeeds, when building first coverage."`
}

// picksNextStep is the operator runbook (services/jobs/README.md "picks",
// docs/plans/stock-picker.md §7, docs/plans/fundamentals-coverage.md §3.7 and
// §9) as one line per mode, so an agent building first coverage is told the
// order rather than guessing it. Coverage is judged on
// fundamentals_rows_count (stocks with any fundamentals row), not on the
// growth count: a stock can hold full statements and still have no
// year-on-year pair.
func picksNextStep(mode jobmonitor.PicksMode) string {
	switch mode {
	case jobmonitor.PicksModeFundamentals:
		return "A fundamentals run works through the universe in priority order (due filers, never-attempted codes by market cap, failures, then the stalest) until its budget of about 170 minutes is spent. Then run filings, then refresh. Coverage is built when get_strategy_picks on the public server reports fundamentals_rows_count near the codes our data providers publish statements for (about three quarters of universe_count); run fundamentals again for any remainder."
	case jobmonitor.PicksModeFilings:
		return "Run refresh so the rebuilt filing rows reach mv_fundamentals_growth and mv_fundamentals_quality. Exit 10 means the rebuild was refused (a read failed or found no extractions) and nothing was written."
	case jobmonitor.PicksModeRefresh:
		return "The run waits 16 minutes after the refresh (the API's strategy cache), then asks the picks pages to revalidate (best effort), so get_strategy_picks reads the refreshed views once it succeeds and /picks follows."
	case jobmonitor.PicksModeAll:
		return "Nothing: this is the nightly sequence. Check get_strategy_picks for fundamentals_rows_count (stocks with any fundamentals) and fundamentals_coverage_count (those with growth figures)."
	}
	return ""
}

func runPicksJobTool() AdminTool {
	t := AdminTool{Name: "run_picks_job", Scope: ScopeJobsRun}
	t.register = func(server *sdk.Server, pub AdminOperator) {
		sdk.AddTool(server, &sdk.Tool{
			Name:  t.Name,
			Title: "Run the stock picker data job",
			Description: "Start one execution of the shorted-picks Cloud Run job (`shorted picks -mode <mode>`), the data layer behind " +
				"https://shorted.com.au/picks and the public list_strategies / get_strategy_picks / get_stock_fundamentals tools. " +
				"Use it to build or top up fundamentals coverage without waiting for the nightly 15:00 UTC schedule. " +
				"Writes to stock_fundamentals and refreshes materialized views; refuses to start while another picks run is in flight. " +
				"Poll picks_job_status with the returned execution_name.",
			Annotations: &sdk.ToolAnnotations{
				ReadOnlyHint:    false,
				DestructiveHint: boolPtr(false),
				IdempotentHint:  false,
				OpenWorldHint:   boolPtr(true), // fundamentals and all reach Yahoo / Markit
			},
		}, func(ctx context.Context, req *sdk.CallToolRequest, in RunPicksJobInput) (*sdk.CallToolResult, RunPicksJobOutput, error) {
			if denied := requireScope(req, t.Scope); denied != nil {
				return denied, RunPicksJobOutput{}, nil
			}
			run, err := pub.RunPicks(ctx, jobmonitor.PicksRequest{Mode: in.Mode, Force: in.Force, Actor: adminActor(req)})
			if err != nil {
				return adminToolError(err), RunPicksJobOutput{}, nil
			}
			out := RunPicksJobOutput{ExecutionName: run.ExecutionName, Mode: string(run.Mode), Args: run.Args, Next: picksNextStep(run.Mode)}
			text := fmt.Sprintf("Started shorted-picks in mode %s (execution %s, args %s). Check picks_job_status for the outcome. %s",
				run.Mode, run.ExecutionName, strings.Join(run.Args, " "), out.Next)
			return &sdk.CallToolResult{Content: []sdk.Content{&sdk.TextContent{Text: text}}}, out, nil
		})
	}
	return t
}

// --- picks_job_status --------------------------------------------------------

// PicksJobStatusInput names the run to poll.
type PicksJobStatusInput struct {
	ExecutionName string `json:"execution_name" jsonschema:"The execution_name run_picks_job returned."`
}

// PicksJobStatusOutput is the run's state. The job has no report artifact: its
// exit code is the verdict (0 ok, 10 DEGRADED, 1 failed), so a failed status
// with an exit-10 message means a partial pull, not a broken job.
type PicksJobStatusOutput struct {
	ExecutionName string `json:"execution_name"`
	Status        string `json:"status" jsonschema:"running, succeeded, failed or unknown. Exit 10 in the message is DEGRADED: under half the attempted codes answered, or the filings rebuild was refused (a read failed or found no extractions, so nothing was written); the rest of the run still landed."`
	StartedAt     string `json:"started_at,omitempty"`
	CompletedAt   string `json:"completed_at,omitempty"`
	LogURI        string `json:"log_uri,omitempty" jsonschema:"Cloud Logging link for the run."`
	Message       string `json:"message,omitempty" jsonschema:"Why it failed, when it failed."`
}

func picksJobStatusTool() AdminTool {
	t := AdminTool{Name: "picks_job_status", Scope: ScopeJobsRun}
	t.register = func(server *sdk.Server, pub AdminOperator) {
		sdk.AddTool(server, &sdk.Tool{
			Name:        t.Name,
			Title:       "Check a stock picker data run",
			Description: "Report whether a run_picks_job execution is still running, succeeded or failed, with its log link and failure reason.",
			Annotations: &sdk.ToolAnnotations{ReadOnlyHint: true, OpenWorldHint: boolPtr(false)},
		}, func(ctx context.Context, req *sdk.CallToolRequest, in PicksJobStatusInput) (*sdk.CallToolResult, PicksJobStatusOutput, error) {
			if denied := requireScope(req, t.Scope); denied != nil {
				return denied, PicksJobStatusOutput{}, nil
			}
			st, err := pub.PicksResult(ctx, in.ExecutionName)
			if err != nil {
				return adminToolError(err), PicksJobStatusOutput{}, nil
			}
			out := PicksJobStatusOutput{
				ExecutionName: st.ExecutionName, Status: st.Status, StartedAt: st.StartedAt,
				CompletedAt: st.CompletedAt, LogURI: st.LogUri, Message: st.Message,
			}
			text := fmt.Sprintf("%s: %s", st.ExecutionName, st.Status)
			if st.Message != "" {
				text += " — " + st.Message
			}
			return &sdk.CallToolResult{Content: []sdk.Content{&sdk.TextContent{Text: text}}}, out, nil
		})
	}
	return t
}

// adminToolError turns a refusal into a tool-level error the model can read
// and act on (a bad slug, a run already in flight), rather than a protocol
// error. Unexpected failures stay generic.
func adminToolError(err error) *sdk.CallToolResult {
	var running *jobmonitor.AlreadyRunningError
	msg := "the run could not be started; the job monitor rejected the request"
	switch {
	case errors.Is(err, jobmonitor.ErrInvalidSlug), errors.Is(err, jobmonitor.ErrInvalidPicksMode):
		msg = err.Error()
	case errors.Is(err, jobmonitor.ErrInvalidExecution):
		msg = "that is not a valid execution name"
	case errors.As(err, &running):
		msg = running.Error() + " — wait for it, or retry with force=true"
	case errors.Is(err, jobmonitor.ErrUnknownJob), errors.Is(err, jobmonitor.ErrRetiredJob), errors.Is(err, jobmonitor.ErrNotExecutable):
		msg = "that job is not deployed as a runnable Cloud Run Job in this environment"
	case errors.Is(err, jobmonitor.ErrNoProject), errors.Is(err, jobmonitor.ErrOverridesUnsupported):
		msg = "job execution is not configured in this deployment"
	}
	res := &sdk.CallToolResult{}
	res.SetError(errors.New(msg))
	return res
}
