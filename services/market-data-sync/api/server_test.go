package api

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestSyncAllGuardAllowsOnlyOneActiveRun(t *testing.T) {
	server := NewServer(0)

	require.True(t, server.beginSyncAll())
	require.False(t, server.beginSyncAll())

	server.finishSyncAll()
	require.True(t, server.beginSyncAll())
}
