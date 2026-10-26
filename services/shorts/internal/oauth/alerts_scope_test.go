package oauth

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/castlemilk/shorted.com.au/services/shorts/internal/mcp"
)

// The public resource's scope rule with alerts:write in its vocabulary. An empty request
// is granted the read-only defaults and nothing else; the write scope is granted only to
// a request that names it, and only when the client's registration allows it.
func TestAlertsWriteIsGrantedOnlyWhenAskedFor(t *testing.T) {
	resources := grantableResources(testAPIBase, nil)
	public := &resources[0]
	require.Equal(t, mcp.ResourceURI(testAPIBase), public.uri)

	cases := []struct {
		name, requested, registered, want string
		ok                                bool
	}{
		{"empty request is read-only", "", "", "shorts:read housing:read economy:read politics:read", true},
		{"naming the write scope grants it", "alerts:write", "", "alerts:write", true},
		{"naming it alongside reads grants both", "shorts:read alerts:write", "", "shorts:read alerts:write", true},
		{"a registration with the write scope does not widen an empty request", "", "shorts:read alerts:write", "shorts:read", true},
		// Finding 3: a client registered with read scopes only steps up to the write scope,
		// because the consent ticket binds it and the consent screen shows it.
		{"a read-only registration can still step up to alerts:write", "alerts:write", "shorts:read", "alerts:write", true},
		{"step-up keeps a registered read scope too", "shorts:read alerts:write", "shorts:read", "shorts:read alerts:write", true},
		// Every other scope must be registered, and an admin or unknown scope is never granted here.
		{"an unregistered read scope is still refused", "politics:read", "shorts:read", "", false},
		{"an unknown scope is refused", "alerts:delete", "shorts:read alerts:write", "", false},
		{"an admin scope is refused on the public resource", "jobs:run", "shorts:read alerts:write", "", false},
	}
	for _, c := range cases {
		got, ok := normaliseScope(public, c.requested, c.registered)
		assert.Equal(t, c.ok, ok, c.name)
		if c.ok {
			assert.Equal(t, c.want, got, c.name)
		}
	}
}

// The consent screen names the write scope in the published words, and only when granted.
func TestConsentDescribesAlertsWrite(t *testing.T) {
	lines := DescribeScopes("shorts:read alerts:write")
	require.Len(t, lines, 2)
	assert.Equal(t, "alerts:write", lines[1].Scope)
	assert.Equal(t, "Create, pause, resume and delete own short-interest alerts, and read their history; creating or resuming one needs Premium", lines[1].Description)
	for _, l := range DescribeScopes("shorts:read") {
		assert.NotEqual(t, "alerts:write", l.Scope)
	}
}
