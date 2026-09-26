package mcp

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

// Both servers must hand a client the logo in serverInfo, or the connector
// shows a placeholder.
func TestBothServersAdvertiseTheShortedIcons(t *testing.T) {
	ctx := context.Background()
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
			if !strings.HasPrefix(icon.Source, "https://") || icon.MIMEType == "" {
				t.Errorf("%s: icon %+v must be an absolute https URL with a MIME type", name, icon)
			}
		}
	}
}

func TestFaviconIsServedFromTheAPIHost(t *testing.T) {
	srv := httptest.NewServer(FaviconHandler())
	defer srv.Close()
	resp, err := http.Get(srv.URL + FaviconPath)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK || resp.Header.Get("Content-Type") != "image/x-icon" || len(body) == 0 {
		t.Fatalf("status %d type %q len %d", resp.StatusCode, resp.Header.Get("Content-Type"), len(body))
	}
	// An ICO file starts 00 00 01 00.
	if len(body) < 4 || body[0] != 0 || body[1] != 0 || body[2] != 1 || body[3] != 0 {
		t.Fatalf("embedded favicon is not an ICO file")
	}
}
