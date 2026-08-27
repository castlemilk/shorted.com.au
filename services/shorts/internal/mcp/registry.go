package mcp

import (
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

// registerAll registers every tool this server exposes against the SDK server.
//
// It is a stub: Task 1 ships an empty server on purpose, so the protocol, the
// mount and the edge are proven before any tool — and any auth-bypass risk —
// exists. Task 2 introduces the registry that backs this.
func registerAll(_ *sdk.Server, _ DataSource) {}
