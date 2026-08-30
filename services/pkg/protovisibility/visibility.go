// Package protovisibility answers "is this RPC part of the public API?" from
// the proto registry, so the OpenAPI generator and the MCP server cannot
// disagree with the auth middleware about what is public.
//
// There is exactly one implementation on purpose. Two consumers each deriving
// the public set for themselves is how an internal method quietly ends up
// advertised on one surface and rejected on another.
package protovisibility

import (
	optionsv1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/options/v1"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protoreflect"
	"google.golang.org/protobuf/reflect/protoregistry"

	// This blank import registers the generated shorts.v1alpha1 descriptors in
	// protoregistry.GlobalFiles — one Go package covers all 12 domain proto
	// files. Without it the registry is empty, every method reads as private,
	// and callers see an empty set rather than a failure.
	_ "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
)

// PublicPackage scopes the sweep. Ranging the whole global registry would
// silently adopt any future transitively-registered file that happens to
// annotate a method VISIBILITY_PUBLIC — the public API surface should be a
// deliberate list, not whatever ends up linked into this binary.
const PublicPackage = "shorts.v1alpha1"

// LegacyService duplicates every rpc of the 12 domain services for public-API
// back-compat (enforced by proto_parity_test.go). It is excluded here for the
// same reason buf.gen.yaml excludes it: including it doubles every entry.
const LegacyService = "shorts.v1alpha1.ShortedStocksService"

// PublicMethodNames returns the set of fully-qualified method names —
// "shorts.v1alpha1.StockService.GetStock" — for methods annotated
// VISIBILITY_PUBLIC. Methods with no annotation default to auth-required and
// are therefore absent, matching the auth middleware in
// services/shorts/internal/services/shorts/middleware_connect.go.
func PublicMethodNames() map[string]bool {
	return public(func(svc, method string) string {
		return svc + "." + method
	})
}

// PublicMethodPaths returns the same set keyed by OpenAPI/Connect path —
// "/<service>/<method>".
func PublicMethodPaths() map[string]bool {
	return public(func(svc, method string) string {
		return "/" + svc + "/" + method
	})
}

// public walks the registry once and keys the result with the supplied
// formatter, so the two exported views cannot drift in what they consider
// public — only in how they spell it.
func public(key func(service, method string) string) map[string]bool {
	out := map[string]bool{}

	protoregistry.GlobalFiles.RangeFilesByPackage(PublicPackage, func(fd protoreflect.FileDescriptor) bool {
		services := fd.Services()
		for i := 0; i < services.Len(); i++ {
			svc := services.Get(i)
			if string(svc.FullName()) == LegacyService {
				continue
			}
			methods := svc.Methods()
			for j := 0; j < methods.Len(); j++ {
				m := methods.Get(j)
				vis, _ := proto.GetExtension(m.Options(), optionsv1.E_Visibility).(optionsv1.Visibility)
				if vis != optionsv1.Visibility_VISIBILITY_PUBLIC {
					continue
				}
				out[key(string(svc.FullName()), string(m.Name()))] = true
			}
		}
		return true
	})

	return out
}
