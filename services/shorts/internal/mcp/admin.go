package mcp

// admin.go is a SECOND MCP server, mounted at /mcp/admin, for the handful of
// write operations an administrator drives from an agent — today, publishing a
// merged content/news article.
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
//   - Its one scope, news:publish, is not in Scopes. The public vocabulary is
//     "every scope ends in :read", and an empty scope request on /mcp is
//     granted the whole public vocabulary — keeping news:publish out of it is
//     what stops an ordinary grant from carrying it by default.
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
	AdminServerTitle = "Shorted — admin (publishing)"
)

// AdminScopes is the admin resource's entire scope vocabulary. Kept apart from
// Scopes — see the file header.
var AdminScopes = []string{"news:publish"}

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

// AdminBearerTokenOptions REQUIRE a token carrying news:publish. Unlike the
// public server there is no anonymous path: an unauthenticated request gets the
// 401 + RFC 9728 challenge that starts a client's OAuth flow, and a token
// without the scope gets 403 insufficient_scope.
func AdminBearerTokenOptions(apiBaseURL string) *auth.RequireBearerTokenOptions {
	return &auth.RequireBearerTokenOptions{
		ResourceMetadataURL: AdminProtectedResourceMetadataURL(apiBaseURL),
		Scopes:              append([]string(nil), AdminScopes...),
		ClockSkew:           ClockSkew,
	}
}

// AdminCheck reports whether a user id is currently an administrator.
type AdminCheck func(ctx context.Context, userID string) (bool, error)

// RequireAdmin re-checks admin status on EVERY request, after the bearer token
// has been verified. It must be composed INSIDE auth.RequireBearerToken, which
// is what puts the TokenInfo it reads into the context.
//
// Fails closed: no token info, no check configured, or a failed lookup are all
// 403. A token is only a claim about the past; this is the check about now.
func RequireAdmin(check AdminCheck) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			info := auth.TokenInfoFromContext(r.Context())
			if check == nil || info == nil || strings.TrimSpace(info.UserID) == "" {
				http.Error(w, "forbidden: administrator access required", http.StatusForbidden)
				return
			}
			ok, err := check(r.Context(), info.UserID)
			if err != nil || !ok {
				http.Error(w, "forbidden: administrator access required", http.StatusForbidden)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// AdminPublisher is the slice of the job monitor the admin tools drive. Narrow
// on purpose: the admin server can start and poll a publish, nothing else.
type AdminPublisher interface {
	RunPublish(ctx context.Context, req jobmonitor.PublishRequest) (*jobmonitor.PublishRun, error)
	PublishResult(ctx context.Context, executionName string) (*jobmonitor.PublishStatus, error)
}

// AdminTool is one admin tool. A separate type from Tool so the public
// registry's guards (public RPCs, read-only, catalog, payload budgets) never
// see it.
type AdminTool struct {
	Name     string
	register func(*sdk.Server, AdminPublisher)
}

// AdminRegistry is every tool on the admin server.
func AdminRegistry() []AdminTool {
	return []AdminTool{publishNewsArticleTool(), newsPublishStatusTool()}
}

// NewAdminServer builds the admin MCP server. It has tools only: no resources
// or prompts, which describe the public data surface.
func NewAdminServer(pub AdminPublisher) *sdk.Server {
	server := sdk.NewServer(&sdk.Implementation{
		Name: AdminServerName, Title: AdminServerTitle, Version: ServerVersion,
		WebsiteURL: WebsiteURL, Icons: Icons(),
	}, nil)
	if pub != nil {
		for _, t := range AdminRegistry() {
			t.register(server, pub)
		}
	}
	return server
}

// AdminHandler serves the admin server over the same stateless streamable
// transport as the public one, for the same reasons (see Handler).
func AdminHandler(pub AdminPublisher) http.Handler {
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
	t := AdminTool{Name: "publish_news_article"}
	t.register = func(server *sdk.Server, pub AdminPublisher) {
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
	t := AdminTool{Name: "news_publish_status"}
	t.register = func(server *sdk.Server, pub AdminPublisher) {
		sdk.AddTool(server, &sdk.Tool{
			Name:        t.Name,
			Title:       "Check a news publish run",
			Description: "Report whether a publish_news_article run is still running, succeeded or failed, with its log link and failure reason.",
			Annotations: &sdk.ToolAnnotations{ReadOnlyHint: true, OpenWorldHint: boolPtr(false)},
		}, func(ctx context.Context, _ *sdk.CallToolRequest, in NewsPublishStatusInput) (*sdk.CallToolResult, NewsPublishStatusOutput, error) {
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

// adminToolError turns a refusal into a tool-level error the model can read
// and act on (a bad slug, a run already in flight), rather than a protocol
// error. Unexpected failures stay generic.
func adminToolError(err error) *sdk.CallToolResult {
	var running *jobmonitor.AlreadyRunningError
	msg := "the publish could not be started; the job monitor rejected the request"
	switch {
	case errors.Is(err, jobmonitor.ErrInvalidSlug):
		msg = err.Error()
	case errors.Is(err, jobmonitor.ErrInvalidExecution):
		msg = "that is not a valid execution name"
	case errors.As(err, &running):
		msg = running.Error() + " — wait for it, or retry with force=true"
	case errors.Is(err, jobmonitor.ErrUnknownJob):
		msg = "the shorted-news-publish job is not deployed in this environment"
	case errors.Is(err, jobmonitor.ErrNoProject), errors.Is(err, jobmonitor.ErrOverridesUnsupported):
		msg = "job execution is not configured in this deployment"
	}
	res := &sdk.CallToolResult{}
	res.SetError(errors.New(msg))
	return res
}
