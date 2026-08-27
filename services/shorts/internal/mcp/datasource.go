package mcp

// DataSource is the narrow interface the MCP tools call. It is satisfied by
// *ShortsServer, whose methods are Connect handlers invoked here IN-PROCESS —
// which is precisely why every method listed on it must correspond to a
// VISIBILITY_PUBLIC RPC. See the package doc.
//
// It is deliberately empty for now: Task 1 mounts an MCP server with zero
// tools to prove the protocol, and Task 2 declares the real methods.
type DataSource interface{}
