package mcp

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

// connectWithSource is connectInMemory with a data source, so resource and
// prompt tests run against the same server shape a real client sees.
func connectWithSource(t *testing.T) *sdk.ClientSession {
	t.Helper()
	ctx := context.Background()

	server := NewServer(&fakeDataSource{})
	client := sdk.NewClient(&sdk.Implementation{Name: "resource-test", Version: "0.0.1"}, nil)

	clientTransport, serverTransport := sdk.NewInMemoryTransports()
	serverSession, err := server.Connect(ctx, serverTransport, nil)
	if err != nil {
		t.Fatalf("server connect: %v", err)
	}
	t.Cleanup(func() { _ = serverSession.Close() })

	session, err := client.Connect(ctx, clientTransport, nil)
	if err != nil {
		t.Fatalf("client connect: %v", err)
	}
	t.Cleanup(func() { _ = session.Close() })

	return session
}

// Resources are static interpretation context, not data. They must be present
// even on a server with no data source — a client that cannot call a tool can
// still need to know what T+4 means.
func TestResourcesListMatchesTheRegistry(t *testing.T) {
	ctx := context.Background()

	server := NewServer(nil)
	client := sdk.NewClient(&sdk.Implementation{Name: "resource-test", Version: "0.0.1"}, nil)
	clientTransport, serverTransport := sdk.NewInMemoryTransports()
	serverSession, err := server.Connect(ctx, serverTransport, nil)
	if err != nil {
		t.Fatalf("server connect: %v", err)
	}
	t.Cleanup(func() { _ = serverSession.Close() })
	session, err := client.Connect(ctx, clientTransport, nil)
	if err != nil {
		t.Fatalf("client connect: %v", err)
	}
	t.Cleanup(func() { _ = session.Close() })

	res, err := session.ListResources(ctx, nil)
	if err != nil {
		t.Fatalf("resources/list: %v", err)
	}

	registered := Resources()
	if len(registered) == 0 {
		t.Fatal("no resources registered")
	}
	if len(res.Resources) != len(registered) {
		t.Fatalf("resources/list served %d, Resources() holds %d", len(res.Resources), len(registered))
	}

	served := map[string]*sdk.Resource{}
	for _, r := range res.Resources {
		served[r.URI] = r
	}
	for _, want := range registered {
		got, ok := served[want.URI]
		if !ok {
			t.Errorf("resource %q is registered but not served", want.URI)
			continue
		}
		if got.Description != want.Description {
			t.Errorf("resource %q: served description differs from the registry's", want.URI)
		}
		if got.MIMEType == "" {
			t.Errorf("resource %q: no MIME type — a client cannot tell how to render it", want.URI)
		}
	}
}

// Every advertised resource must actually resolve. An advertised-but-404
// resource is worse than no resource: the client burns a round trip and gets
// an error it cannot act on.
func TestEveryResourceResolvesWithContent(t *testing.T) {
	ctx := context.Background()
	session := connectWithSource(t)

	for _, want := range Resources() {
		t.Run(want.URI, func(t *testing.T) {
			res, err := session.ReadResource(ctx, &sdk.ReadResourceParams{URI: want.URI})
			if err != nil {
				t.Fatalf("resources/read %s: %v", want.URI, err)
			}
			if len(res.Contents) != 1 {
				t.Fatalf("resources/read %s returned %d contents, want 1", want.URI, len(res.Contents))
			}
			content := res.Contents[0]
			if content.URI != want.URI {
				t.Errorf("content URI = %q, want %q", content.URI, want.URI)
			}
			if len(strings.TrimSpace(content.Text)) < 200 {
				t.Errorf("resource %s has %d bytes of text — too thin to be worth a round trip",
					want.URI, len(content.Text))
			}
		})
	}
}

// An unknown URI must fail cleanly rather than serving an empty document that
// a model would read as "there is nothing to know here".
func TestUnknownResourceURIErrors(t *testing.T) {
	session := connectWithSource(t)
	if _, err := session.ReadResource(context.Background(), &sdk.ReadResourceParams{
		URI: "shorted://guide/does-not-exist",
	}); err == nil {
		t.Fatal("reading an unknown resource URI succeeded; want an error")
	}
}

// resources/list is session preamble in most clients, exactly like tools/list.
// It is not part of the tools budget, but it is still spent on every session,
// so it gets its own ceiling. Three good resources, not eight thin ones.
const maxResourcesListBytes = 4096

func TestResourcesListStaysSmall(t *testing.T) {
	res, err := connectWithSource(t).ListResources(context.Background(), nil)
	if err != nil {
		t.Fatalf("resources/list: %v", err)
	}
	encoded, err := json.Marshal(res)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	t.Logf("resources/list = %d bytes across %d resources", len(encoded), len(res.Resources))
	if len(encoded) > maxResourcesListBytes {
		t.Errorf("resources/list is %d bytes, over the %d-byte budget — trim descriptions or drop a resource",
			len(encoded), maxResourcesListBytes)
	}
}

// The interpretation context the tools cannot carry themselves. If these facts
// stop being stated, an agent reading a short-interest percentage has no way
// to know it is up to a week stale.
func TestReadingGuideStatesTheFactsToolsCannot(t *testing.T) {
	res, err := connectWithSource(t).ReadResource(context.Background(), &sdk.ReadResourceParams{
		URI: readingGuideURI,
	})
	if err != nil {
		t.Fatalf("resources/read: %v", err)
	}
	text := res.Contents[0].Text
	for _, want := range []string{"T+4", "net short position", "0.01%", "not short-sale flow"} {
		if !strings.Contains(text, want) {
			t.Errorf("reading guide does not mention %q", want)
		}
	}
}

// The coverage resource exists to say what is NOT here as loudly as what is.
// Both licence exclusions are contractual, not editorial.
func TestCoverageResourceStatesTheExclusions(t *testing.T) {
	res, err := connectWithSource(t).ReadResource(context.Background(), &sdk.ReadResourceParams{
		URI: coverageURI,
	})
	if err != nil {
		t.Fatalf("resources/read: %v", err)
	}
	text := strings.ToLower(res.Contents[0].Text)
	for _, want := range []string{
		"individual property listings", // crawl rows are never republished raw
		"no amounts",                   // the register carries what is held, never how much
		"cc by-nc-nd",                  // APH prose must stay verbatim
	} {
		if !strings.Contains(text, want) {
			t.Errorf("coverage resource does not state %q", want)
		}
	}
}
