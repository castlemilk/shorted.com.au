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
		{"a client that did not register the write scope cannot ask for it", "alerts:write", "shorts:read", "", false},
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
	assert.Equal(t, "Create, pause and delete own short-interest alerts; creating one needs Premium", lines[1].Description)
	for _, l := range DescribeScopes("shorts:read") {
		assert.NotEqual(t, "alerts:write", l.Scope)
	}
}
