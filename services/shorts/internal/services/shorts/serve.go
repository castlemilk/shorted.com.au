package shorts

import (
	"bytes"
	"context"
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"time"

	"connectrpc.com/connect"
	connectcors "connectrpc.com/cors"
	"github.com/rs/cors"

	"github.com/castlemilk/shorted.com.au/services/pkg/log"
	shortedotel "github.com/castlemilk/shorted.com.au/services/pkg/otel"
	"github.com/castlemilk/shorted.com.au/services/pkg/ratelimit"
	"github.com/castlemilk/shorted.com.au/services/shorts/internal/jobmonitor"
	"github.com/castlemilk/shorted.com.au/services/shorts/internal/mcp"
	"github.com/castlemilk/shorted.com.au/services/shorts/internal/oauth"
	"github.com/castlemilk/shorted.com.au/services/shorts/internal/services/register"
	"github.com/castlemilk/shorted.com.au/services/shorts/internal/services/shorts/broadcast"

	"github.com/castlemilk/shorted.com.au/services/gen/proto/go/register/v1/registerv1connect"
	registerreviewv1connect "github.com/castlemilk/shorted.com.au/services/gen/proto/go/registerreview/v1/registerreviewv1connect"
	shortsv1alpha1connect "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1/shortsv1alpha1connect"
	stocksv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/stocks/v1alpha1"
	"github.com/rakyll/statik/fs"

	_ "github.com/castlemilk/shorted.com.au/services/shorts/internal/api/schema/statik"
	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
	"golang.org/x/net/http2"
	//nolint:staticcheck // SA1019: deprecated, but still the only h2c that serves the
	// HTTP/1.1 Upgrade handshake — see the h2c.NewHandler call for the full rationale.
	"golang.org/x/net/http2/h2c"
)

// politiciansAlgoliaIndex is the register-of-interests search index. It is a
// constant rather than config on purpose: it is the ONLY index name besides the
// configured default that /api/algolia/search will serve, and keeping the
// allowlist in code means adding one is a reviewed change, not an env edit.
const politiciansAlgoliaIndex = "politicians"

// withCORS adds CORS support to a Connect HTTP handler.
func withCORS(h http.Handler) http.Handler {
	middleware := cors.New(cors.Options{
		AllowedOrigins: []string{"http://localhost:3000", "http://localhost:3001", "http://localhost:3020", "https://*.vercel.app", "https://*.shorted.com.au", "https://shorted.com.au"},
		AllowedMethods: connectcors.AllowedMethods(),
		AllowedHeaders: append([]string{"Authorization"}, connectcors.AllowedHeaders()...),
		ExposedHeaders: connectcors.ExposedHeaders(),
	})
	return middleware.Handler(h)
}

// adminAuthMiddleware wraps an http.HandlerFunc with secret-based authentication.
// It checks the Authorization header (Bearer token) or x-internal-secret header
// against the INTERNAL_SERVICE_SECRET environment variable.
// In non-production environments without INTERNAL_SERVICE_SECRET set, admin
// endpoints are accessible without authentication for development convenience.
func adminAuthMiddleware(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// Allow preflight CORS requests through without auth
		if r.Method == http.MethodOptions {
			next(w, r)
			return
		}

		expectedSecret := os.Getenv("INTERNAL_SERVICE_SECRET")
		if expectedSecret == "" {
			// Check if we're in production - fail closed
			// Support both ENV and ENVIRONMENT (Terraform/Cloud Run uses ENVIRONMENT)
			env := os.Getenv("ENV")
			if env == "" {
				env = os.Getenv("ENVIRONMENT")
			}
			if env == "production" || env == "prod" {
				log.Errorf("INTERNAL_SERVICE_SECRET not set in production; denying admin access")
				http.Error(w, "Forbidden", http.StatusForbidden)
				return
			}
			// In development, allow unauthenticated admin access
			next(w, r)
			return
		}

		// Check Authorization: Bearer <secret> header first
		providedSecret := ""
		authHeader := r.Header.Get("Authorization")
		if len(authHeader) > 7 && authHeader[:7] == "Bearer " {
			providedSecret = authHeader[7:]
		}
		// Fall back to x-internal-secret header
		if providedSecret == "" {
			providedSecret = r.Header.Get("x-internal-secret")
		}

		if providedSecret == "" || subtle.ConstantTimeCompare([]byte(providedSecret), []byte(expectedSecret)) != 1 {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}

		next(w, r)
	}
}

// writeJobRunError emits the machine-readable refusal shape the admin console
// switches on ({error, message}) with the given status.
func writeJobRunError(w http.ResponseWriter, status int, code, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": code, "message": message})
}

// envOr returns the value of the environment variable named by key, or
// fallback if the variable is unset or empty.
func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func (s *ShortsServer) Serve(ctx context.Context, logger *log.Logger, address string) error {

	mux := http.NewServeMux()

	// Create interceptors - order matters!
	// 0. OTel interceptor runs first to capture the full request lifecycle
	// 1. Auth runs second to populate user context (including subscription tier lookup)
	// 2. User-Agent check runs third to reject scrapers before rate limiting
	// 3. Rate limit runs last to check limits based on user tier
	var interceptorList []connect.Interceptor

	// OTel interceptor captures spans and metrics for every RPC call
	interceptorList = append(interceptorList, shortedotel.OTelInterceptor())

	// Create auth interceptor with subscription lookup
	authOpts := AuthInterceptorOptions{
		TokenService: s.tokenService,
		SubscriptionLookup: func(userID string) (string, error) {
			sub, err := s.store.GetAPISubscription(userID)
			if err != nil {
				return "", err
			}
			if sub == nil {
				return "free", nil // No subscription = free tier
			}
			// Only return tier for active/trialing subscriptions
			if sub.Status == "active" || sub.Status == "trialing" {
				return sub.Tier, nil
			}
			return "free", nil // Inactive subscription = free tier
		},
	}
	interceptorList = append(interceptorList, NewAuthInterceptorWithOptions(authOpts))

	// User-Agent interceptor runs after auth (so authenticated users are exempt)
	// but before rate limiting (to reject scrapers early before consuming rate limit quota)
	interceptorList = append(interceptorList, ratelimit.UserAgentInterceptor(userKey))

	if s.rateLimiter != nil {
		interceptorList = append(interceptorList,
			ratelimit.NewRateLimitInterceptor(s.rateLimiter, s.config.RateLimitConfig, userKey))
	}

	interceptors := connect.WithInterceptors(interceptorList...)

	shortsPath, shortsHandler := shortsv1alpha1connect.NewShortedStocksServiceHandler(s, interceptors)
	registerPath, registerHandler := registerv1connect.NewRegisterServiceHandler(s.registerServer, interceptors)
	shortsHandler = withCORS(shortsHandler)
	registerHandler = withCORS(registerHandler)
	// handler = AuthMiddleware(handler)
	mux.Handle(shortsPath, shortsHandler)
	mux.Handle(registerPath, registerHandler)

	// Per-domain services over the same ShortsServer. The legacy monolithic
	// ShortedStocksService above stays mounted for external consumers (public
	// API docs, chat tools, twitter bot, MCP); web clients migrate to these so
	// each route's bundle only carries its own domain's descriptor. mount
	// applies the same interceptors chain (passed to each constructor) +
	// withCORS — never mux.Handle a connect handler directly or it silently
	// loses auth, rate limiting and CORS.
	mount := func(path string, handler http.Handler) {
		mux.Handle(path, withCORS(handler))
	}
	mount(shortsv1alpha1connect.NewMarketServiceHandler(s, interceptors))
	mount(shortsv1alpha1connect.NewStockServiceHandler(s, interceptors))
	mount(shortsv1alpha1connect.NewSearchServiceHandler(s, interceptors))
	mount(shortsv1alpha1connect.NewScreenerServiceHandler(s, interceptors))
	mount(shortsv1alpha1connect.NewNewsServiceHandler(s, interceptors))
	mount(shortsv1alpha1connect.NewEnrichmentServiceHandler(s, interceptors))
	mount(shortsv1alpha1connect.NewBillingServiceHandler(s, interceptors))
	mount(shortsv1alpha1connect.NewAlertsServiceHandler(s, interceptors))
	mount(shortsv1alpha1connect.NewReportsServiceHandler(s, interceptors))
	mount(shortsv1alpha1connect.NewHousingServiceHandler(s, interceptors))
	mount(shortsv1alpha1connect.NewEconomyServiceHandler(s, interceptors))
	mount(shortsv1alpha1connect.NewIndustryIntelligenceServiceHandler(s, interceptors))
	mount(shortsv1alpha1connect.NewPoliticiansServiceHandler(s, interceptors))
	// Operator console. Its own package, not shorts.v1alpha1: every rpc there
	// must also exist on the legacy public ShortedStocksService, and admin write
	// methods do not belong on the surface external API consumers hold.
	mount(registerreviewv1connect.NewRegisterReviewServiceHandler(s, interceptors))

	// MCP (Model Context Protocol) — protocol 2026-07-28, streamable HTTP.
	// Deliberately NOT via mount(): that helper is for Connect handlers, and
	// this is JSON-RPC. Tools call this same ShortsServer in-process, which
	// skips the interceptor chain above; see the mcp package doc for why that
	// constrains them to VISIBILITY_PUBLIC methods.
	//
	// OAuth 2.1 resource-server wrapping. A bearer token is OPTIONAL: no
	// Authorization header still means anonymous access to all 24 tools, which
	// is what makes this server adoptable. A token that IS presented is
	// verified — signature, expiry, and RFC 8707 audience binding to this
	// deployment's /mcp resource — and its identity attached to the request
	// context for later tasks. A bad one earns a 401 with the RFC 9728
	// challenge instead of a silent downgrade to anonymous.
	//
	// Nothing is gated on the token yet; tier gating is a later task.
	//
	// The origin comes from config (API_BASE_URL), not the environment
	// directly: it must be the SAME origin New() minted the token audience
	// against, or the server would refuse the tokens it issues.
	apiBaseURL := s.config.APIBaseURL
	if apiBaseURL == "" {
		apiBaseURL = mcp.DefaultAPIBaseURL
	}
	// Rate limiting, over the SAME limiter the Connect interceptor uses.
	//
	// It is INSIDE the bearer middleware, not outside, and that order is the
	// whole reason an authenticated caller gets their own tier: the identity
	// function reads the verified TokenInfo that OptionalBearerToken puts in
	// the context, and outside it every caller would look anonymous.
	//
	// Cost is per TOOL CALL, so a JSON-RPC batch is charged for each one and
	// session preamble is free. Rejections are JSON-RPC errors carrying the
	// documented RateLimitDetail — an MCP client cannot relay a bare 429.
	mcpRateLimit := ratelimit.NewHTTPMiddleware(
		s.rateLimiter,
		s.config.RateLimitConfig,
		mcp.RateLimitIdentity(mcp.TierResolver(authOpts.SubscriptionLookup)),
		ratelimit.WithCost(mcp.RateLimitCost),
		// The rejection needs the metadata URL because an anonymous caller at
		// their ceiling is answered with a 401 challenge, which is what lets a
		// client discover the authorization server at all.
		ratelimit.WithRejection(mcp.RateLimitRejection(mcp.ProtectedResourceMetadataURL(apiBaseURL))),
	)
	mcpHandler := mcp.OptionalBearerToken(
		mcp.NewTokenVerifier(s.tokenService, mcp.ResourceURI(apiBaseURL)),
		mcp.BearerTokenOptions(apiBaseURL),
	)(mcpRateLimit(mcp.Handler(s)))
	// Both paths: the SDK's streamable transport uses the bare path, and
	// clients sometimes append a trailing segment.
	mux.Handle("/mcp", mcpHandler)
	mux.Handle("/mcp/", mcpHandler)

	// RFC 9728 protected resource metadata. This is the document the
	// WWW-Authenticate challenge points at, and the first thing an MCP client
	// fetches when it decides it needs to authenticate — it is how a client
	// learns which authorization server to talk to without being told.
	protectedResourceMetadata := mcp.ProtectedResourceMetadataHandler(apiBaseURL)
	mux.Handle(mcp.ProtectedResourceMetadataPath, protectedResourceMetadata)
	// The bare path, aliased. Some clients probe it before reading the
	// challenge, and a 404 there reads as "this server does not do OAuth".
	mux.Handle(mcp.BareProtectedResourceMetadataPath, protectedResourceMetadata)

	// The published tool catalog. Everything that describes this server to the
	// outside world — the SEP-1649 server card, /docs/mcp.md — renders from
	// here, so a tool cannot be advertised without being registered.
	//
	// The exact pattern wins over "/mcp/" above by ServeMux's longest-match
	// rule, so this does not have to be registered first.
	mux.Handle("/mcp/catalog.json", mcp.CatalogHandler(s, mcp.CatalogOptions{
		APIBaseURL: apiBaseURL,
		// Read from the running config, so the published document stops
		// disclaiming the moment app-layer limiting is switched on.
		RateLimitEnabled: s.config.RateLimitConfig.Enabled,
	}))

	// OAuth 2.1 AUTHORIZATION SERVER. Same process as the resource server
	// above, deliberately: the access tokens are HS256 with a symmetric secret,
	// so splitting mint and verify across two platforms would mean sharing that
	// secret and rotating it in two places.
	//
	// Mounted directly, NOT via mount(): that helper is for Connect handlers
	// and applies the browser CORS policy. These are plain HTTP endpoints
	// consumed by OAuth clients, and the metadata document sets its own
	// wildcard CORS because discovery is public and non-credentialed.
	oauthEndpoints := oauth.Endpoints{
		APIBaseURL: apiBaseURL,
		ConsentURL: s.config.OAuthConsentURL,
	}
	// RFC 8414 discovery. This is how a client learns where to send the human,
	// where to exchange the code, and that PKCE S256 is the only method.
	mux.Handle(oauth.AuthorizationServerMetadataPath, oauth.MetadataHandler(oauthEndpoints))

	// Client resolution. A client_id that is an https URL is a Client ID
	// Metadata Document — the preferred path in protocol 2026-07-28 — and is
	// resolved by FETCHING it, under an SSRF policy that refuses private
	// address space after DNS resolution and follows no redirects. Anything
	// else is an opaque id looked up in oauth_clients. The wrapper means the
	// grant and token handlers never have to know which kind they were given.
	//
	// Nil-safe: NewResolvingStore returns nil for a nil inner store, and a nil
	// *ResolvingStore would be a non-nil interface, so the assignment is
	// conditional — otherwise the handlers' "not configured" branch would never
	// fire and they would panic on first use instead.
	var oauthClients oauth.ClientStore = s.oauthStore
	if s.oauthStore != nil {
		oauthClients = oauth.NewResolvingStore(s.oauthStore, oauth.NewMetadataFetcher(oauth.MetadataFetcherConfig{}))
		// An open registration endpoint accumulates junk. The sweep deletes
		// clients idle for longer than the longest-lived credential they could
		// hold, and refuses to touch any client that still has a live token or
		// an unexpired code — the foreign keys cascade, so "unused" has to be
		// proved, not assumed.
		oauth.StartClientSweeper(ctx, s.oauthStore, 24*time.Hour)
	}

	// Rate limiting for the OAuth endpoints.
	//
	// These are plain mux handlers, so the Connect interceptor never sees them,
	// and each one does expensive work on behalf of an UNAUTHENTICATED caller:
	// the grant redeems a ticket and may verify a Firebase ID token, and
	// registration writes a row and can fetch a client metadata document.
	// Before this their only ceiling was the tier-blind, per-colo Cloudflare
	// bucket — which does not exist locally or in preview at all.
	//
	// Keyed by IP, because there is no identity yet: establishing one is what
	// the request is FOR. The middleware runs before the handler, so the
	// expensive part is behind the limit rather than in front of it.
	oauthRateLimit := ratelimit.NewHTTPMiddleware(
		s.rateLimiter,
		s.config.RateLimitConfig,
		func(r *http.Request) ratelimit.Caller {
			return ratelimit.Caller{
				Identifier: "oauth-anon:" + ratelimit.ClientIP(r),
				Tier:       "anonymous",
			}
		},
	)

	// The consent-screen support endpoints. INTERNAL: they are called by the
	// Next.js consent screen's server side and gated on INTERNAL_SERVICE_SECRET,
	// because minting proof-of-consent must require something an attacker
	// holding only a stolen user credential does not have.
	//
	// The environment is read HERE and passed in, rather than read inside the
	// oauth package, so the gate is a value the tests can construct.
	consentAuthorizer := oauth.InternalSecretAuthorizer(
		os.Getenv("INTERNAL_SERVICE_SECRET"),
		firstNonEmptyStr(os.Getenv("ENV"), os.Getenv("ENVIRONMENT")),
	)
	consentConfig := oauth.ConsentConfig{
		Endpoints: oauthEndpoints,
		Store:     oauthClients,
		Tickets:   s.oauthStore,
		Authorize: consentAuthorizer,
	}
	// What the human must be shown, computed by the same validation the grant
	// applies — so the screen cannot describe one request and authorise another.
	mux.Handle(oauth.ConsentDescribePath, oauth.NewConsentDescribeHandler(consentConfig))
	// Minted only after an explicit approval.
	mux.Handle(oauth.ConsentTicketPath, oauth.NewConsentTicketHandler(consentConfig))

	// The grant. Called by the Next.js consent screen AFTER a human approves.
	// No browser is ever redirected here, and the authority is the CONSENT
	// TICKET — a Firebase ID token, if one is passed, is only cross-checked
	// against the ticket's subject. See NewConsentTicketHandler for why an ID
	// token alone was not enough once dynamic registration shipped.
	mux.Handle(oauth.GrantPath, oauthRateLimit(oauth.NewGrantHandler(oauth.GrantConfig{
		Endpoints: oauthEndpoints,
		Identity:  firebaseIdentityVerifier{},
		Store:     oauthClients,
		Consent:   s.oauthStore,
	})))
	// RFC 7591 dynamic client registration. Deprecated in protocol 2026-07-28
	// in favour of CIMD above, but retained because Claude and ChatGPT still
	// use it. It is unauthenticated by definition, so it is rate limited and
	// capped per IP and its rows are swept.
	mux.Handle(oauth.RegisterPath, oauthRateLimit(oauth.NewRegistrationHandler(oauth.RegistrationConfig{
		Endpoints: oauthEndpoints,
		Store:     s.oauthStore,
	})))
	// The token exchange. PKCE on the authorization_code grant, rotation with
	// family revocation on the refresh grant.
	//
	// ResolveTier is the SAME lookup the Connect interceptor uses, so an OAuth
	// token is stamped with the tier the API would have resolved anyway. It is
	// a hint either way: tier is re-resolved from the store on every request and
	// never trusted from the token.
	mux.Handle(oauth.TokenPath, oauthRateLimit(oauth.NewTokenHandler(oauth.TokenConfig{
		Endpoints:   oauthEndpoints,
		Store:       oauthClients,
		Minter:      s.tokenService,
		ResolveTier: oauth.TierResolver(authOpts.SubscriptionLookup),
	})))

	// Add health check endpoint
	// Bulk panel export. One request replaces the ~2,500 GetMarketByDate calls
	// a decade-long research panel used to cost, which is cheaper for us to
	// serve than the pattern it replaces — but it is not one request's worth of
	// work, so it is metered at panelExportCost rather than 1.
	//
	// Keyed by IP at the anonymous tier: the endpoint is public like the rest
	// of the read surface, and the quota is what bounds it.
	panelRateLimit := ratelimit.NewHTTPMiddleware(
		s.rateLimiter,
		s.config.RateLimitConfig,
		func(r *http.Request) ratelimit.Caller {
			return ratelimit.Caller{
				Identifier: "panel-anon:" + ratelimit.ClientIP(r),
				Tier:       "anonymous",
			}
		},
		ratelimit.WithCost(func(*http.Request) int { return panelExportCost }),
	)
	mux.Handle(PanelExportPath, withCORS(panelRateLimit(s.PanelExportHandler())))

	// The latest-publication feed. Metered at the ordinary one unit: it exists
	// precisely so a daily engine can poll cheaply instead of burning its whole
	// quota diffing GetAvailableDates, and charging it more would defeat that.
	mux.Handle(LatestPath, withCORS(s.LatestHandler()))

	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		if _, err := w.Write([]byte("OK")); err != nil {
			log.Errorf("Error writing response: %v", err)
		}
	})

	// Add stock search endpoint
	mux.HandleFunc("/api/stocks/search", func(w http.ResponseWriter, r *http.Request) {
		// Add CORS headers
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")

		// Handle preflight OPTIONS request
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusOK)
			return
		}

		if r.Method != http.MethodGet {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}

		query := r.URL.Query().Get("q")
		if query == "" {
			http.Error(w, "Missing query parameter 'q'", http.StatusBadRequest)
			return
		}

		limitStr := r.URL.Query().Get("limit")
		limit := int32(50) // default
		if limitStr != "" {
			if _, err := fmt.Sscanf(limitStr, "%d", &limit); err != nil {
				http.Error(w, "Invalid limit parameter", http.StatusBadRequest)
				return
			}
			// Validate limit is non-negative and reasonable
			if limit < 0 {
				http.Error(w, "Limit must be non-negative", http.StatusBadRequest)
				return
			}
			// Cap limit at 1000 to prevent DOS
			if limit > 1000 {
				limit = 1000
			}
		}

		// Search stocks
		if s.store == nil {
			logger.Errorf("Store is nil")
			http.Error(w, "Service not initialized", http.StatusInternalServerError)
			return
		}

		// Check cache first
		cacheKey := s.cache.GetSearchStocksKey(query, limit)

		// Use cached result or fetch from Algolia/database
		cachedResult, err := s.cache.GetOrSet(cacheKey, func() (interface{}, error) {
			// Try Algolia first if configured
			if s.config.AlgoliaAppID != "" && s.config.AlgoliaSearchKey != "" {
				logger.Debugf("searching via Algolia: query='%s'", query)
				stocks, algoliaErr := s.searchAlgolia(query, limit)
				if algoliaErr == nil && len(stocks) > 0 {
					return stocks, nil
				}
				logger.Warnf("Algolia search failed or returned no results for '%s', falling back to PostgreSQL: %v", query, algoliaErr)
			}

			// Fall back to PostgreSQL
			logger.Debugf("cache miss for SearchStocks, fetching from database: query='%s'", query)
			return s.store.SearchStocks(query, limit)
		})

		if err != nil {
			logger.Errorf("Error searching stocks for query '%s': %v", query, err)
			// Check if it's a timeout error
			if err.Error() == "search query timed out" {
				http.Error(w, "Search timeout", http.StatusRequestTimeout)
			} else {
				http.Error(w, "Internal server error", http.StatusInternalServerError)
			}
			return
		}

		stocks := cachedResult.([]*stocksv1alpha1.Stock)

		// Convert to JSON response
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)

		// Create proper JSON response structure
		type StockResponse struct {
			ProductCode            string   `json:"product_code"`
			Name                   string   `json:"name"`
			PercentageShorted      float64  `json:"percentage_shorted"`
			TotalProductInIssue    float64  `json:"total_product_in_issue"`
			ReportedShortPositions float64  `json:"reported_short_positions"`
			Industry               string   `json:"industry"`
			Tags                   []string `json:"tags"`
			LogoUrl                string   `json:"logoUrl"`
		}

		type SearchResponse struct {
			Query  string          `json:"query"`
			Stocks []StockResponse `json:"stocks"`
			Count  int             `json:"count"`
		}

		// Convert stocks to response format
		stockResponses := make([]StockResponse, len(stocks))
		for i, stock := range stocks {
			stockResponses[i] = StockResponse{
				ProductCode:            stock.ProductCode,
				Name:                   stock.Name,
				PercentageShorted:      float64(stock.PercentageShorted),
				TotalProductInIssue:    float64(stock.TotalProductInIssue),
				ReportedShortPositions: float64(stock.ReportedShortPositions),
				Industry:               stock.Industry,
				Tags:                   stock.Tags,
				LogoUrl:                stock.LogoUrl,
			}
		}

		response := SearchResponse{
			Query:  query,
			Stocks: stockResponses,
			Count:  len(stocks),
		}

		// Marshal to JSON
		if err := json.NewEncoder(w).Encode(response); err != nil {
			logger.Errorf("Error encoding JSON response: %v", err)
			return
		}
	})

	// Add Algolia search proxy endpoint
	mux.HandleFunc("/api/algolia/search", func(w http.ResponseWriter, r *http.Request) {
		// Add CORS headers
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")

		// Handle preflight OPTIONS request
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusOK)
			return
		}

		if r.Method != http.MethodPost && r.Method != http.MethodGet {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}

		// Check if Algolia is configured
		if s.config.AlgoliaAppID == "" || s.config.AlgoliaSearchKey == "" {
			logger.Warnf("Algolia not configured, falling back to PostgreSQL search")
			http.Error(w, "Algolia not configured", http.StatusServiceUnavailable)
			return
		}

		var query string
		var requestedIndex string
		hitsPerPage := 20

		if r.Method == http.MethodGet {
			query = r.URL.Query().Get("q")
			requestedIndex = r.URL.Query().Get("index")
			if limitStr := r.URL.Query().Get("limit"); limitStr != "" {
				if _, err := fmt.Sscanf(limitStr, "%d", &hitsPerPage); err != nil {
					logger.Debugf("Error parsing limit parameter '%s': %v", limitStr, err)
				}
			}
		} else {
			// Parse POST body
			var reqBody struct {
				Query        string        `json:"query"`
				Index        string        `json:"index"`
				HitsPerPage  int           `json:"hitsPerPage"`
				Filters      string        `json:"filters"`
				FacetFilters []interface{} `json:"facetFilters"`
				Facets       []string      `json:"facets"`
			}
			if err := json.NewDecoder(r.Body).Decode(&reqBody); err != nil {
				http.Error(w, "Invalid request body", http.StatusBadRequest)
				return
			}
			query = reqBody.Query
			requestedIndex = reqBody.Index
			if reqBody.HitsPerPage > 0 {
				hitsPerPage = reqBody.HitsPerPage
			}
			// Store extra params for forwarding
			r.Header.Set("X-Algolia-Filters", reqBody.Filters)
			if len(reqBody.FacetFilters) > 0 {
				facetFiltersBytes, _ := json.Marshal(reqBody.FacetFilters)
				r.Header.Set("X-Algolia-FacetFilters", string(facetFiltersBytes))
			}
			if len(reqBody.Facets) > 0 {
				facetsBytes, _ := json.Marshal(reqBody.Facets)
				r.Header.Set("X-Algolia-Facets", string(facetsBytes))
			}
		}

		// AN EMPTY QUERY IS VALID and must not 400.
		//
		// Algolia treats "" as "match everything", which is exactly what a
		// facet-driven browse UI opens with: the /politicians explorer shows the
		// full roll with facet counts before anyone types. Rejecting it forced
		// every such caller to send a junk query, which changes the ranking and
		// the facet counts it gets back.
		//
		// Cap hitsPerPage
		if hitsPerPage > 100 {
			hitsPerPage = 100
		}

		// Build Algolia request.
		//
		// THE INDEX IS ALLOWLISTED, NEVER TAKEN FROM THE CLIENT VERBATIM. This
		// handler holds the Algolia search key and proxies with it, so a
		// caller-supplied index name would turn it into an open read proxy for
		// every index on the application — including any that is not meant to be
		// public. The client picks from a fixed set of names; anything else
		// falls back to the configured default rather than erroring, so a
		// stale client degrades to stocks instead of breaking.
		indexName := s.config.AlgoliaIndex
		if indexName == "" {
			indexName = "stocks"
		}
		switch requestedIndex {
		case "politicians":
			indexName = politiciansAlgoliaIndex
		case "stocks", "":
			// default, already set
		default:
			logger.Warnf("rejected unknown algolia index %q; serving %q", requestedIndex, indexName)
		}

		algoliaURL := fmt.Sprintf("https://%s-dsn.algolia.net/1/indexes/%s/query",
			s.config.AlgoliaAppID, indexName)

		algoliaReqBody := map[string]interface{}{
			"query":       query,
			"hitsPerPage": hitsPerPage,
		}
		// Forward optional filter/facet parameters
		if filters := r.Header.Get("X-Algolia-Filters"); filters != "" {
			algoliaReqBody["filters"] = filters
		}
		if facetFiltersStr := r.Header.Get("X-Algolia-FacetFilters"); facetFiltersStr != "" {
			var facetFilters []interface{}
			if json.Unmarshal([]byte(facetFiltersStr), &facetFilters) == nil {
				algoliaReqBody["facetFilters"] = facetFilters
			}
		}
		if facetsStr := r.Header.Get("X-Algolia-Facets"); facetsStr != "" {
			var facets []string
			if json.Unmarshal([]byte(facetsStr), &facets) == nil {
				algoliaReqBody["facets"] = facets
			}
		}
		reqBodyBytes, _ := json.Marshal(algoliaReqBody)

		algoliaReq, err := http.NewRequest("POST", algoliaURL, bytes.NewReader(reqBodyBytes))
		if err != nil {
			logger.Errorf("Error creating Algolia request: %v", err)
			http.Error(w, "Internal server error", http.StatusInternalServerError)
			return
		}

		// Use search key (safe for read operations)
		algoliaReq.Header.Set("X-Algolia-API-Key", s.config.AlgoliaSearchKey)
		algoliaReq.Header.Set("X-Algolia-Application-Id", s.config.AlgoliaAppID)
		algoliaReq.Header.Set("Content-Type", "application/json")

		// Make request to Algolia
		client := &http.Client{}
		resp, err := client.Do(algoliaReq)
		if err != nil {
			logger.Errorf("Error calling Algolia: %v", err)
			http.Error(w, "Search service unavailable", http.StatusServiceUnavailable)
			return
		}
		defer func() {
			_ = resp.Body.Close()
		}()

		// Forward response
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(resp.StatusCode)
		if _, err := io.Copy(w, resp.Body); err != nil {
			logger.Errorf("Error copying Algolia response: %v", err)
		}
	})

	// Rate-limit health, behind the internal secret.
	//
	// The limiter is unconditionally fail-open, so a degraded quota database
	// looks exactly like a healthy one from outside: requests succeed, they are
	// simply no longer metered. This endpoint is the only way to tell those
	// apart, and .github/workflows/rate-limit-sentinel.yml is what reads it —
	// metrics alone were not enough, because nothing was watching them.
	//
	// Gated because it reports operational state (how much is buffered, how
	// close the identifier map is to its cap) that is of no use to a caller and
	// some use to someone probing for a window where quotas are not enforced.
	mux.HandleFunc("/api/admin/rate-limit-health", adminAuthMiddleware(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")

		payload := map[string]any{
			"enabled": s.config.RateLimitConfig.Enabled,
		}
		// A nil limiter means rate limiting is off; report that rather than a
		// zero-valued Health that would read as "on and perfectly healthy".
		if limiter, ok := s.rateLimiter.(*ratelimit.AppLimiter); ok && limiter != nil {
			payload["health"] = limiter.Health()
		}
		if err := json.NewEncoder(w).Encode(payload); err != nil {
			logger.Errorf("Error writing rate limit health: %v", err)
		}
	}))

	// Add admin sync status endpoint (requires INTERNAL_SERVICE_SECRET auth)
	mux.HandleFunc("/api/admin/sync-status", adminAuthMiddleware(func(w http.ResponseWriter, r *http.Request) {
		// Add CORS headers
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")

		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusOK)
			return
		}

		if r.Method != http.MethodGet {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}

		// Parse filter parameters
		limitStr := r.URL.Query().Get("limit")
		limit := 20 // default
		if limitStr != "" {
			if _, err := fmt.Sscanf(limitStr, "%d", &limit); err != nil {
				logger.Debugf("Error parsing limit parameter '%s': %v", limitStr, err)
			}
		}
		if limit > 100 {
			limit = 100
		}

		// Environment filter: "production", "development", or empty for all
		environment := r.URL.Query().Get("environment")

		// Exclude local runs by default for cleaner production view
		excludeLocal := r.URL.Query().Get("excludeLocal") != "false"

		// Get sync status from store with filtering
		filter := shortsstore.SyncStatusFilter{
			Limit:        limit,
			Environment:  environment,
			ExcludeLocal: excludeLocal,
		}
		runs, err := s.store.GetSyncStatus(filter)
		if err != nil {
			logger.Errorf("Failed to get sync status: %v", err)
			http.Error(w, "Failed to get sync status", http.StatusInternalServerError)
			return
		}

		// Build response
		type SyncRunResponse struct {
			RunId                 string  `json:"runId"`
			StartedAt             string  `json:"startedAt"`
			CompletedAt           string  `json:"completedAt"`
			Status                string  `json:"status"`
			ErrorMessage          string  `json:"errorMessage"`
			ShortsRecordsUpdated  int32   `json:"shortsRecordsUpdated"`
			PricesRecordsUpdated  int32   `json:"pricesRecordsUpdated"`
			MetricsRecordsUpdated int32   `json:"metricsRecordsUpdated"`
			AlgoliaRecordsSynced  int32   `json:"algoliaRecordsSynced"`
			TotalDurationSeconds  float64 `json:"totalDurationSeconds"`
			Environment           string  `json:"environment"`
			Hostname              string  `json:"hostname"`
		}

		type Response struct {
			Runs []SyncRunResponse `json:"runs"`
		}

		runResponses := make([]SyncRunResponse, len(runs))
		for i, run := range runs {
			runResponses[i] = SyncRunResponse{
				RunId:                 run.RunId,
				StartedAt:             run.StartedAt,
				CompletedAt:           run.CompletedAt,
				Status:                run.Status,
				ErrorMessage:          run.ErrorMessage,
				ShortsRecordsUpdated:  run.ShortsRecordsUpdated,
				PricesRecordsUpdated:  run.PricesRecordsUpdated,
				MetricsRecordsUpdated: run.MetricsRecordsUpdated,
				AlgoliaRecordsSynced:  run.AlgoliaRecordsSynced,
				TotalDurationSeconds:  run.TotalDurationSeconds,
				Environment:           run.Environment,
				Hostname:              run.Hostname,
			}
		}

		w.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(w).Encode(Response{Runs: runResponses}); err != nil {
			logger.Errorf("Error encoding JSON response: %v", err)
			return
		}
	}))

	// Add admin jobs overview endpoint (requires INTERNAL_SERVICE_SECRET auth).
	// Reports the run status of EVERY scheduled async job by reading Cloud Run
	// Job executions + Cloud Scheduler triggers directly — no per-job DB
	// instrumentation required, so the whole fleet is visible immediately.
	mux.HandleFunc("/api/admin/jobs", adminAuthMiddleware(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")

		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusOK)
			return
		}
		if r.Method != http.MethodGet {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}

		ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
		defer cancel()

		jobs, err := s.jobsCollector.Collect(ctx)
		stale := false
		if err != nil {
			if jobs == nil {
				logger.Errorf("Failed to collect job status: %v", err)
				http.Error(w, "Failed to get job status", http.StatusInternalServerError)
				return
			}
			// Serving last-known-good data on a transient GCP error.
			stale = true
			logger.Warnf("Serving stale job status after collect error: %v", err)
		}

		// Merge in the Mac-based residential-crawl health records (migration 000089).
		// jobmonitor.Collect() is GCP-only (Cloud Run + Cloud Scheduler) and cannot
		// observe the crawl, which runs on a residential Mac — so these rows come from
		// the DB. Best-effort: a read failure omits them rather than failing the whole
		// endpoint. Appended after the GCP jobs (frontend highlights critical rows).
		// Build a FRESH slice rather than appending onto `jobs` — the collector may
		// return its internal cached slice, and appending into spare capacity would
		// corrupt that cache for other requests.
		if crawlJobs := s.crawlJobStatuses(); len(crawlJobs) > 0 {
			merged := make([]jobmonitor.JobStatus, 0, len(jobs)+len(crawlJobs))
			merged = append(merged, jobs...)
			merged = append(merged, crawlJobs...)
			jobs = merged
		} else {
			// Still copy before mutating: applySyncStatusDetail writes into the
			// slice, and `jobs` may be the collector's internal cached slice.
			jobs = append([]jobmonitor.JobStatus(nil), jobs...)
		}

		// Fold the sync_status row into the shorts-data-sync entry. Cloud Run only
		// knows the container exited 0; sync_status knows whether it wrote anything
		// — the difference is the "exit 0 but did nothing" failure class.
		jobs = applySyncStatusDetail(jobs, s.syncStatusDetail(), time.Now().UTC())

		type Response struct {
			Jobs  []jobmonitor.JobStatus `json:"jobs"`
			Stale bool                   `json:"stale"`
		}

		w.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(w).Encode(Response{Jobs: jobs, Stale: stale}); err != nil {
			logger.Errorf("Error encoding job status response: %v", err)
			return
		}
	}))

	// Admin: run a job on demand — POST /api/admin/jobs/run.
	// Handler body lives in jobs_run.go so it can be unit-tested without a server.
	mux.HandleFunc("/api/admin/jobs/run", adminAuthMiddleware(adminJobsRunHandler(logger, s.jobsCollector)))

	// Admin: per-stock, READ-ONLY validation of the ASIC sync —
	// POST /api/admin/jobs/validate-sync (start) + GET ?execution= (poll).
	// The only endpoint that runs a job with arguments, and the arguments are
	// constructed server-side from a validated stock list. See jobs_validate.go.
	mux.HandleFunc("/api/admin/jobs/validate-sync", adminAuthMiddleware(adminJobsValidateSyncHandler(logger, s.jobsCollector)))

	// Admin: list broadcasts
	mux.HandleFunc("/api/admin/broadcasts", adminAuthMiddleware(func(w http.ResponseWriter, r *http.Request) {
		items, err := s.store.ListBroadcasts(50)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		if items == nil {
			items = []shortsstore.Broadcast{}
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(items)
	}))

	// Admin: send a broadcast — POST /api/admin/broadcasts/send?id=UUID
	mux.HandleFunc("/api/admin/broadcasts/send", adminAuthMiddleware(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		id := r.URL.Query().Get("id")
		if id == "" {
			http.Error(w, "missing id", http.StatusBadRequest)
			return
		}
		if os.Getenv("UNSUBSCRIBE_SECRET") == "" {
			http.Error(w, "unsubscribe secret not configured; refusing to send", http.StatusInternalServerError)
			return
		}
		b, err := s.store.GetBroadcast(id)
		if err != nil {
			http.Error(w, "broadcast not found", http.StatusNotFound)
			return
		}
		cfg := broadcast.Config{
			APIKey:            os.Getenv("RESEND_API_KEY"),
			From:              envOr("BROADCAST_FROM", "Shorted <updates@shorted.com.au>"),
			ReplyTo:           envOr("BROADCAST_REPLY_TO", "support@shorted.com.au"),
			UnsubscribeSecret: os.Getenv("UNSUBSCRIBE_SECRET"),
			BaseURL:           envOr("PUBLIC_SITE_URL", "https://shorted.com.au"),
		}

		// TEST SEND: ?to=<email> delivers to that ONE address only. It must be an
		// active subscriber (so the unsubscribe link is real). This never claims,
		// never touches the subscriber list, and never changes the broadcast status
		// — the draft stays sendable for the real blast.
		if to := r.URL.Query().Get("to"); to != "" {
			subs, err := s.store.ListActiveSubscribers()
			if err != nil {
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
			var recip *broadcast.Recipient
			for _, su := range subs {
				if su.Email == to {
					recip = &broadcast.Recipient{ID: su.ID, Email: su.Email}
					break
				}
			}
			if recip == nil {
				http.Error(w, "test recipient must be an active subscriber", http.StatusBadRequest)
				return
			}
			sent, sendErr := broadcast.Send(r.Context(), cfg, b.Subject, b.Subject, b.HTMLBody, b.TextBody, []broadcast.Recipient{*recip}, register.SignUnsubscribeToken)
			if sendErr != nil {
				http.Error(w, sendErr.Error(), http.StatusInternalServerError)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{"sent": sent, "test": true, "to": to})
			return
		}

		claimed, err := s.store.ClaimBroadcastForSending(id)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		if !claimed {
			http.Error(w, "broadcast already sent or sending", http.StatusConflict)
			return
		}
		subs, err := s.store.ListActiveSubscribers()
		if err != nil {
			if markErr := s.store.SetBroadcastStatus(id, "failed", err.Error(), 0); markErr != nil {
				log.Errorf("broadcast %s: failed to mark failed after subscriber list error: %v", id, markErr)
			}
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		recips := make([]broadcast.Recipient, len(subs))
		for i, su := range subs {
			recips[i] = broadcast.Recipient{ID: su.ID, Email: su.Email}
		}
		sent, sendErr := broadcast.Send(r.Context(), cfg, b.Subject, b.Subject, b.HTMLBody, b.TextBody, recips, register.SignUnsubscribeToken)
		if sendErr != nil {
			if err := s.store.SetBroadcastStatus(id, "failed", sendErr.Error(), sent); err != nil {
				log.Errorf("broadcast %s: failed to mark failed: %v", id, err)
			}
			http.Error(w, sendErr.Error(), http.StatusInternalServerError)
			return
		}
		if err := s.store.SetBroadcastStatus(id, "sent", "", sent); err != nil {
			log.Errorf("broadcast %s: failed to mark sent: %v", id, err)
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"sent": sent})
	}))

	// Add admin cleanup endpoint for stuck sync runs (requires INTERNAL_SERVICE_SECRET auth)
	mux.HandleFunc("/api/admin/cleanup-stuck-runs", adminAuthMiddleware(func(w http.ResponseWriter, r *http.Request) {
		// Add CORS headers
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")

		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusOK)
			return
		}

		if r.Method != http.MethodPost {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}

		// Clean up stuck runs (running for more than 5 hours)
		count, err := s.store.CleanupStuckSyncRuns()
		if err != nil {
			logger.Errorf("Failed to cleanup stuck runs: %v", err)
			http.Error(w, "Failed to cleanup stuck runs", http.StatusInternalServerError)
			return
		}

		type CleanupResponse struct {
			CleanedUp int    `json:"cleanedUp"`
			Message   string `json:"message"`
		}

		w.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(w).Encode(CleanupResponse{
			CleanedUp: count,
			Message:   fmt.Sprintf("Cleaned up %d stuck job(s)", count),
		}); err != nil {
			logger.Errorf("Error encoding JSON response: %v", err)
			return
		}
	}))

	// Add internal Algolia sync endpoint (requires INTERNAL_SERVICE_SECRET auth)
	// Called by enrichment-processor after auto-approve and by ReviewEnrichment after manual approval.
	mux.HandleFunc("/api/internal/algolia/sync-stock", adminAuthMiddleware(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusOK)
			return
		}

		if r.Method != http.MethodPost {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}

		// Check if Algolia admin key is configured
		if s.config.AlgoliaAppID == "" || s.config.AlgoliaAdminKey == "" {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusServiceUnavailable)
			_ = json.NewEncoder(w).Encode(map[string]interface{}{
				"synced":  false,
				"message": "Algolia admin key not configured",
			})
			return
		}

		var reqBody struct {
			StockCode string `json:"stock_code"`
		}
		if err := json.NewDecoder(r.Body).Decode(&reqBody); err != nil {
			http.Error(w, "Invalid request body", http.StatusBadRequest)
			return
		}

		stockCode := NormalizeStockCode(reqBody.StockCode)
		if stockCode == "" {
			http.Error(w, "stock_code is required", http.StatusBadRequest)
			return
		}

		// Sync to Algolia
		ctx := r.Context()
		if err := s.syncStockToAlgolia(ctx, stockCode); err != nil {
			logger.Errorf("Failed to sync %s to Algolia: %v", stockCode, err)
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusInternalServerError)
			_ = json.NewEncoder(w).Encode(map[string]interface{}{
				"synced":     false,
				"stock_code": stockCode,
				"error":      err.Error(),
			})
			return
		}

		logger.Infof("Synced %s to Algolia via internal API", stockCode)
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"synced":     true,
			"stock_code": stockCode,
		})
	}))

	// Add statik file server
	statikFS, err := fs.New()
	if err != nil {
		return fmt.Errorf("failed to create statik filesystem: %w", err)
	}
	mux.Handle("/api/docs/", withCORS(http.StripPrefix("/api/docs/", http.FileServer(statikFS))))

	// Wrap the mux with OTel HTTP middleware for non-RPC endpoints
	// (health, search, admin, docs), then with h2c for HTTP/2 support.
	handler := shortedotel.HTTPMiddleware(mux)

	return http.ListenAndServe(
		address,
		// Use h2c so we can serve HTTP/2 without TLS.
		//
		// Deprecated in favour of http.Server.Protocols + SetUnencryptedHTTP2, but
		// that is a NARROWING, not a drop-in: net/http only detects the HTTP/2
		// client preface (prior knowledge, server.go maybeServeUnencryptedHTTP2),
		// while h2c.NewHandler also serves the HTTP/1.1 `Upgrade: h2c` handshake.
		// Swapping it is a change to how this API negotiates every connection and
		// belongs in its own change with its own verification, not here.
		//nolint:staticcheck // SA1019: see above — deliberate, tracked separately.
		h2c.NewHandler(handler, &http2.Server{}),
	)
}
