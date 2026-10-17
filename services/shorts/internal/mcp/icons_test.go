package mcp

import (
	"bytes"
	"context"
	"encoding/binary"
	"fmt"
	"image/png"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

// Both servers must hand a client the logo in serverInfo, or the connector
// shows a placeholder.
func TestBothServersAdvertiseTheShortedIcons(t *testing.T) {
	ctx := context.Background()
	endpoint, err := url.Parse(PublicEndpoint)
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	RegisterIconHandlers(mux)
	iconsServer := httptest.NewServer(mux)
	t.Cleanup(iconsServer.Close)
	for name, server := range map[string]*sdk.Server{
		"public": NewServer(nil),
		"admin":  NewAdminServer(nil),
	} {
		clientT, serverT := sdk.NewInMemoryTransports()
		if _, err := server.Connect(ctx, serverT, nil); err != nil {
			t.Fatal(err)
		}
		session, err := sdk.NewClient(&sdk.Implementation{Name: "t", Version: "1"}, nil).Connect(ctx, clientT, nil)
		if err != nil {
			t.Fatal(err)
		}
		info := session.InitializeResult().ServerInfo
		_ = session.Close()
		if info.WebsiteURL != WebsiteURL {
			t.Errorf("%s: websiteUrl = %q", name, info.WebsiteURL)
		}
		if len(info.Icons) == 0 {
			t.Fatalf("%s: no icons in serverInfo", name)
		}
		for _, icon := range info.Icons {
			source, err := url.Parse(icon.Source)
			if err != nil {
				t.Fatal(err)
			}
			if source.Scheme != endpoint.Scheme || source.Host != endpoint.Host {
				t.Errorf("%s: icon %q must share MCP endpoint origin %s://%s", name, icon.Source, endpoint.Scheme, endpoint.Host)
			}
			if source.User != nil || source.RawQuery != "" || source.Fragment != "" {
				t.Errorf("%s: icon %q must not require credentials or signed URLs", name, icon.Source)
			}
			// Fetch the advertised path from the public routes production mounts.
			// The fresh client sends neither authorization nor cookies.
			resp, body := fetchPublicIcon(t, iconsServer.URL, http.MethodGet, source.EscapedPath())
			if resp.StatusCode != http.StatusOK || resp.Header.Get("Content-Type") != icon.MIMEType {
				t.Fatalf("%s: icon %q status %d type %q, want 200 %q", name, icon.Source, resp.StatusCode, resp.Header.Get("Content-Type"), icon.MIMEType)
			}
			actualSize := iconDimensions(t, body, icon.MIMEType)
			if len(icon.Sizes) != 1 || icon.Sizes[0] != actualSize {
				t.Errorf("%s: icon %q declares %v, actual image is %s", name, icon.Source, icon.Sizes, actualSize)
			}
		}
	}
}

func fetchPublicIcon(t *testing.T, origin, method, path string) (*http.Response, []byte) {
	t.Helper()
	req, err := http.NewRequest(method, origin+path, nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Origin", "https://claude.ai")
	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	}}
	resp, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	body, err := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if err != nil {
		t.Fatal(err)
	}
	if resp.Header.Get("WWW-Authenticate") != "" || resp.Header.Get("Set-Cookie") != "" {
		t.Errorf("%s %s: public icon returned authentication or cookies", method, path)
	}
	return resp, body
}

func iconDimensions(t *testing.T, data []byte, mimeType string) string {
	t.Helper()
	if mimeType == "image/x-icon" {
		if len(data) < 22 || !bytes.Equal(data[:6], []byte{0, 0, 1, 0, 1, 0}) {
			t.Fatal("expected a single-image ICO")
		}
		// Decode the PNG payload to check actual pixels, then verify the ICO
		// directory agrees rather than trusting its declared dimensions.
		start := uint64(binary.LittleEndian.Uint32(data[18:22]))
		length := uint64(binary.LittleEndian.Uint32(data[14:18]))
		if start+length > uint64(len(data)) {
			t.Fatal("ICO image payload extends past file")
		}
		config, err := png.DecodeConfig(bytes.NewReader(data[start : start+length]))
		if err != nil {
			t.Fatal(err)
		}
		if int(data[6]) != config.Width || int(data[7]) != config.Height {
			t.Fatal("ICO directory does not match embedded image dimensions")
		}
		return fmt.Sprintf("%dx%d", config.Width, config.Height)
	}
	if mimeType != "image/png" {
		t.Fatalf("unexpected icon MIME type %q", mimeType)
	}
	config, err := png.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	return fmt.Sprintf("%dx%d", config.Width, config.Height)
}

func TestPublicIconRoutesSupportGetAndHead(t *testing.T) {
	mux := http.NewServeMux()
	RegisterIconHandlers(mux)
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	for _, asset := range []struct {
		path, mimeType, size string
	}{
		{FaviconPath, "image/x-icon", "16x16"},
		{"/icon-192.png", "image/png", "192x192"},
		{"/icon-512.png", "image/png", "512x512"},
		{"/apple-touch-icon.png", "image/png", "180x180"},
		{"/", "text/html; charset=utf-8", ""},
	} {
		t.Run(asset.path, func(t *testing.T) {
			for _, method := range []string{http.MethodGet, http.MethodHead, http.MethodPost} {
				resp, body := fetchPublicIcon(t, srv.URL, method, asset.path)
				if method == http.MethodPost {
					if resp.StatusCode != http.StatusMethodNotAllowed || resp.Header.Get("Allow") != "GET, HEAD" {
						t.Errorf("POST: status %d Allow %q", resp.StatusCode, resp.Header.Get("Allow"))
					}
					continue
				}
				if resp.StatusCode != http.StatusOK || resp.Header.Get("Content-Type") != asset.mimeType || resp.Header.Get("Cache-Control") != "public, max-age=86400" {
					t.Errorf("%s: status %d headers %v", method, resp.StatusCode, resp.Header)
				}
				if asset.size != "" && resp.Header.Get("Access-Control-Allow-Origin") != "*" {
					t.Errorf("%s: public icon lacks anonymous cross-origin fetch support", method)
				}
				if method == http.MethodHead {
					if len(body) != 0 {
						t.Errorf("HEAD returned %d body bytes", len(body))
					}
					// net/http suppresses HEAD bodies on the wire. Check the handler
					// itself also avoids writing/processing the image payload.
					rec := httptest.NewRecorder()
					mux.ServeHTTP(rec, httptest.NewRequest(method, asset.path, nil))
					if rec.Body.Len() != 0 {
						t.Errorf("HEAD handler wrote %d body bytes", rec.Body.Len())
					}
				} else if asset.size != "" {
					if size := iconDimensions(t, body, asset.mimeType); size != asset.size {
						t.Errorf("GET image is %s, want %s", size, asset.size)
					}
				}
			}
		})
	}
}

// Favicon resolvers read the root document's <link rel="icon">, and the root
// route must match "/" ONLY — never swallow the API's other 404s.
func TestRootDocumentNamesTheIconsAndMatchesOnlySlash(t *testing.T) {
	mux := http.NewServeMux()
	RegisterIconHandlers(mux)
	srv := httptest.NewServer(mux)
	defer srv.Close()

	resp, err := http.Get(srv.URL + "/")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK || !strings.Contains(string(body), `rel="icon"`) ||
		!strings.Contains(string(body), "/favicon.ico") {
		t.Fatalf("root: status %d body %s", resp.StatusCode, body)
	}
	for _, path := range []string{FaviconPath, "/icon-192.png", "/icon-512.png", "/apple-touch-icon.png"} {
		if !strings.Contains(string(body), `href="`+path+`"`) {
			t.Errorf("root does not name same-origin icon %s", path)
		}
	}

	resp, err = http.Get(srv.URL + "/no-such-path")
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("unmatched path: status %d, want 404", resp.StatusCode)
	}
}
