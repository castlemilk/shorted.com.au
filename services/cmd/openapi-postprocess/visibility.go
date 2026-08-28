package main

import (
	optionsv1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/options/v1"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protoreflect"
	"google.golang.org/protobuf/reflect/protoregistry"

	// This blank import registers the generated shorts.v1alpha1 descriptors in
	// protoregistry.GlobalFiles — one Go package covers all 12 domain proto
	// files. Without it the registry is empty, every method reads as private,
	// and the post-processor prunes the entire document instead of failing.
	_ "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
)

// publicPackage scopes the sweep. Ranging the whole global registry would
// silently adopt any future transitively-registered file that happens to
// annotate a method VISIBILITY_PUBLIC — the public API surface should be a
// deliberate list, not whatever ends up linked into this binary.
const publicPackage = "shorts.v1alpha1"

// legacyService duplicates every rpc of the 12 domain services for public-API
// back-compat (enforced by proto_parity_test.go). It is excluded here for the
// same reason buf.gen.yaml excludes it: including it doubles every path.
const legacyService = "shorts.v1alpha1.ShortedStocksService"

// PublicMethodPaths returns the set of OpenAPI paths — "/<service>/<method>" —
// for methods annotated VISIBILITY_PUBLIC. Methods with no annotation default
// to auth-required and are therefore absent, matching the auth middleware in
// services/shorts/internal/services/shorts/middleware_connect.go.
func PublicMethodPaths() map[string]bool {
	out := map[string]bool{}

	protoregistry.GlobalFiles.RangeFilesByPackage(publicPackage, func(fd protoreflect.FileDescriptor) bool {
		services := fd.Services()
		for i := 0; i < services.Len(); i++ {
			svc := services.Get(i)
			if string(svc.FullName()) == legacyService {
				continue
			}
			methods := svc.Methods()
			for j := 0; j < methods.Len(); j++ {
				m := methods.Get(j)
				vis, _ := proto.GetExtension(m.Options(), optionsv1.E_Visibility).(optionsv1.Visibility)
				if vis != optionsv1.Visibility_VISIBILITY_PUBLIC {
					continue
				}
				out["/"+string(svc.FullName())+"/"+string(m.Name())] = true
			}
		}
		return true
	})

	return out
}
