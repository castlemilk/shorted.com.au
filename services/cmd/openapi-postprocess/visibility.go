package main

import (
	optionsv1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/options/v1"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protoreflect"
	"google.golang.org/protobuf/reflect/protoregistry"

	// Blank imports register the descriptors in protoregistry.GlobalFiles.
	// Without them the registry is empty and every method reads as private.
	_ "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
)

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

	protoregistry.GlobalFiles.RangeFiles(func(fd protoreflect.FileDescriptor) bool {
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
