package ratelimit

import (
	"context"
	"fmt"
	"strings"

	"connectrpc.com/connect"
	"github.com/castlemilk/shorted.com.au/services/pkg/log"
)

// blockedUserAgentPatterns contains substrings that identify known scrapers, bots,
// and automated HTTP clients. These are checked case-insensitively against the
// User-Agent header. Authenticated users (with a valid API token or Firebase auth)
// are exempt from this check — they may use any User-Agent including scripts.
var blockedUserAgentPatterns = []string{
	"curl",
	"wget",
	"python-requests",
	"python-urllib",
	"scrapy",
	"httpclient",
	"go-http-client",
	"node-fetch",
	"axios",
	"libwww-perl",
	"java/",
	"apache-httpclient",
	"mechanize",
	"phantomjs",
	"headlesschrome",
	"selenium",
	"puppeteer",
	"httpie",
	"postman",
	"insomnia",
	"aiohttp",
	"okhttp",
	"ruby",
	"perl",
	"lwp-trivial",
	"colly",
	"fasthttp",
}

// UserAgentInterceptor creates a Connect unary interceptor that blocks requests
// from known scraper/bot User-Agents. Only unauthenticated requests are checked;
// if the auth interceptor has already populated user claims in the context, the
// request is allowed regardless of User-Agent. This allows paid/authenticated
// users to use scripts and automation tools with valid API tokens.
//
// Must be placed AFTER the auth interceptor in the chain so that
// authenticated claims are available in the context.
func UserAgentInterceptor(userClaimsKey any) connect.UnaryInterceptorFunc {
	return func(next connect.UnaryFunc) connect.UnaryFunc {
		return func(ctx context.Context, req connect.AnyRequest) (connect.AnyResponse, error) {
			// If the user is authenticated (claims exist in context from the auth
			// interceptor), skip the User-Agent check entirely. Authenticated users
			// with valid API tokens or Firebase auth can use any client.
			if claims := ctx.Value(userClaimsKey); claims != nil {
				return next(ctx, req)
			}

			// For unauthenticated requests, inspect the User-Agent header.
			ua := req.Header().Get("User-Agent")

			// Block requests with an empty User-Agent (common for basic scripts).
			if ua == "" {
				log.Infof("Blocked request with empty User-Agent")
				return nil, connect.NewError(
					connect.CodePermissionDenied,
					fmt.Errorf("automated access detected, please use the API with a valid token, see https://shorted.com.au/docs/api"),
				)
			}

			// Check against blocked patterns using case-insensitive substring matching.
			uaLower := strings.ToLower(ua)
			for _, pattern := range blockedUserAgentPatterns {
				if strings.Contains(uaLower, pattern) {
					log.Infof("Blocked request with User-Agent: %s (matched pattern: %s)", ua, pattern)
					return nil, connect.NewError(
						connect.CodePermissionDenied,
						fmt.Errorf("automated access detected, please use the API with a valid token, see https://shorted.com.au/docs/api"),
					)
				}
			}

			return next(ctx, req)
		}
	}
}
