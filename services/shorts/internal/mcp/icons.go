package mcp

// icons.go is how a client draws Shorted's logo next to the connector.
//
// Clients look in two places, and a connector with neither shows a generic
// placeholder (what claude.ai did on 2026-09-25):
//
//  1. serverInfo.icons in the initialize result (MCP 2025-11-25+). Both the
//     public and the admin server advertise the same set, as absolute URLs on
//     the website, which already serves them with long cache lifetimes.
//  2. The favicon of the server URL's host. The server URL is
//     api.shorted.com.au, which served nothing at /favicon.ico, so FaviconHandler
//     serves the website's favicon from the API binary itself — embedded, so it
//     cannot 404 on a CDN or website outage.
//
// A /favicon.ico alone was NOT enough (measured 2026-09-26: Google's favicon
// service still answered 404 for api.shorted.com.au). Favicon resolvers start
// from the host's ROOT DOCUMENT and read its <link rel="icon">; the API's root
// was a 404, so they never got as far as /favicon.ico. RootHandler gives the
// host a real page that names its icons.

import (
	_ "embed"
	"net/http"

	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

// WebsiteURL is the product site, advertised as serverInfo.websiteUrl.
const WebsiteURL = "https://shorted.com.au"

// Icons is the logo set both servers advertise.
func Icons() []sdk.Icon {
	return []sdk.Icon{
		{Source: WebsiteURL + "/icon-192.png", MIMEType: "image/png", Sizes: []string{"192x192"}},
		{Source: WebsiteURL + "/icon-512.png", MIMEType: "image/png", Sizes: []string{"512x512"}},
		{Source: WebsiteURL + "/favicon.ico", MIMEType: "image/x-icon", Sizes: []string{"32x32"}},
	}
}

// RootPath matches exactly "/" (Go 1.22 pattern syntax) — a bare "/" would
// catch every unmatched path and turn the API's 404s into 200s.
const RootPath = "GET /{$}"

const rootPage = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Shorted API</title>
<link rel="icon" href="/favicon.ico" sizes="32x32">
<link rel="icon" type="image/png" href="` + WebsiteURL + `/icon-192.png" sizes="192x192">
<link rel="apple-touch-icon" href="` + WebsiteURL + `/apple-touch-icon.png">
<meta name="robots" content="noindex">
</head>
<body>
<p>Shorted API. See <a href="` + WebsiteURL + `">shorted.com.au</a>; MCP guide at <a href="` + DocumentationURL + `">` + DocumentationURL + `</a>.</p>
</body>
</html>
`

// RootHandler serves the API host's root document: a minimal page whose only
// job is to name the host's icons for favicon resolvers.
func RootHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "public, max-age=86400")
		_, _ = w.Write([]byte(rootPage))
	})
}

//go:embed assets/favicon.ico
var favicon []byte

// FaviconPath is where FaviconHandler is mounted.
const FaviconPath = "/favicon.ico"

// FaviconHandler serves the Shorted favicon on the API host.
func FaviconHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		w.Header().Set("Content-Type", "image/x-icon")
		w.Header().Set("Cache-Control", "public, max-age=86400")
		if r.Method == http.MethodHead {
			return
		}
		_, _ = w.Write(favicon)
	})
}
