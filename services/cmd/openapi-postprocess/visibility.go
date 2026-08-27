package main

import (
	"github.com/castlemilk/shorted.com.au/services/pkg/protovisibility"
)

// PublicMethodPaths returns the set of OpenAPI paths — "/<service>/<method>" —
// for methods annotated VISIBILITY_PUBLIC.
//
// The implementation lives in services/pkg/protovisibility because the MCP
// server needs the same answer: if the OpenAPI document and the MCP tool
// surface each computed "public" for themselves, they could disagree with each
// other and with the auth middleware. This is a thin alias, kept so the
// post-processor reads in its own vocabulary.
func PublicMethodPaths() map[string]bool {
	return protovisibility.PublicMethodPaths()
}
