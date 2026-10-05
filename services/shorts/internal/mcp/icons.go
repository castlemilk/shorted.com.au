package mcp

// icons.go is how a client draws Shorted's logo next to the connector.
//
// MCP clients should fetch icons only from the MCP server's origin, without
// credentials. Embedding the images in the API binary keeps both servers'
// advertised icons public and on that same origin. RootHandler also gives
// favicon resolvers a host document that links to those public images.

import (
	_ "embed"
	"net/http"
	"strings"

	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

// WebsiteURL is the product site, advertised as serverInfo.websiteUrl.
const WebsiteURL = "https://shorted.com.au"

// Icons is the logo set both servers advertise.
func Icons() []sdk.Icon {
	origin := strings.TrimSuffix(PublicEndpoint, "/mcp")
	return []sdk.Icon{
		{Source: origin + "/icon-192.png", MIMEType: "image/png", Sizes: []string{"192x192"}},
		{Source: origin + "/icon-512.png", MIMEType: "image/png", Sizes: []string{"512x512"}},
		{Source: origin + FaviconPath, MIMEType: "image/x-icon", Sizes: []string{"16x16"}},
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
<link rel="icon" href="/favicon.ico" sizes="16x16">
<link rel="icon" type="image/png" href="/icon-192.png" sizes="192x192">
<link rel="icon" type="image/png" href="/icon-512.png" sizes="512x512">
<link rel="apple-touch-icon" href="/apple-touch-icon.png" sizes="180x180">
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
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "public, max-age=86400")
		if r.Method == http.MethodHead {
			return
		}
		_, _ = w.Write([]byte(rootPage))
	})
}

//go:embed assets/favicon.ico
var favicon []byte

//go:embed assets/icon-192.png
var icon192 []byte

//go:embed assets/icon-512.png
var icon512 []byte

//go:embed assets/apple-touch-icon.png
var appleTouchIcon []byte

// FaviconPath is where FaviconHandler is mounted.
const FaviconPath = "/favicon.ico"

// FaviconHandler serves the Shorted favicon on the API host.
func FaviconHandler() http.Handler {
	return iconHandler(favicon, "image/x-icon")
}

// RegisterIconHandlers mounts the connector's public images and host document.
// Call directly on the server mux, outside OAuth and tool-rate-limit middleware:
// clients fetch these resources without authorization headers or cookies.
func RegisterIconHandlers(mux *http.ServeMux) {
	mux.Handle(RootPath, RootHandler())
	mux.Handle(FaviconPath, FaviconHandler())
	mux.Handle("/icon-192.png", iconHandler(icon192, "image/png"))
	mux.Handle("/icon-512.png", iconHandler(icon512, "image/png"))
	mux.Handle("/apple-touch-icon.png", iconHandler(appleTouchIcon, "image/png"))
}

func iconHandler(data []byte, contentType string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		w.Header().Set("Content-Type", contentType)
		w.Header().Set("Cache-Control", "public, max-age=86400")
		w.Header().Set("Access-Control-Allow-Origin", "*")
		if r.Method == http.MethodHead {
			return
		}
		_, _ = w.Write(data)
	})
}
