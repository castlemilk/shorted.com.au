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
