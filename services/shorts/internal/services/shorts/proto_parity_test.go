package shorts

import (
	"testing"

	optionsv1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/options/v1"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protoreflect"
	"google.golang.org/protobuf/reflect/protoregistry"
)

// TestLegacyDomainServiceParity enforces the dual-service contract from the
// shorts.proto per-domain split: every rpc on the legacy monolithic
// ShortedStocksService must exist on exactly one per-domain service (and vice
// versa) with the same request/response types and the same options.v1
// visibility/required_role annotations. Both services share one ShortsServer
// handler, so a drifted copy silently serves different auth semantics on one
// of the two mounted paths.
func TestLegacyDomainServiceParity(t *testing.T) {
	const pkg = "shorts.v1alpha1"
	const legacyName = pkg + ".ShortedStocksService"

	desc, err := protoregistry.GlobalFiles.FindDescriptorByName(legacyName)
	if err != nil {
		t.Fatalf("legacy service not registered: %v", err)
	}
	legacy := desc.(protoreflect.ServiceDescriptor)

	// Collect every method of every non-legacy service in the package.
	domainMethods := map[string]protoreflect.MethodDescriptor{}
	protoregistry.GlobalFiles.RangeFilesByPackage(pkg, func(fd protoreflect.FileDescriptor) bool {
		services := fd.Services()
		for i := 0; i < services.Len(); i++ {
			svc := services.Get(i)
			if string(svc.FullName()) == legacyName {
				continue
			}
			methods := svc.Methods()
			for j := 0; j < methods.Len(); j++ {
				m := methods.Get(j)
				if prev, dup := domainMethods[string(m.Name())]; dup {
					t.Errorf("method %s defined on two domain services: %s and %s",
						m.Name(), prev.Parent().FullName(), svc.FullName())
				}
				domainMethods[string(m.Name())] = m
			}
		}
		return true
	})

	authOptions := func(m protoreflect.MethodDescriptor) (optionsv1.Visibility, string) {
		opts := m.Options()
		vis := proto.GetExtension(opts, optionsv1.E_Visibility).(optionsv1.Visibility)
		role := proto.GetExtension(opts, optionsv1.E_RequiredRole).(string)
		return vis, role
	}

	legacyMethods := legacy.Methods()
	for i := 0; i < legacyMethods.Len(); i++ {
		lm := legacyMethods.Get(i)
		dm, ok := domainMethods[string(lm.Name())]
		if !ok {
			t.Errorf("legacy method %s has no per-domain twin — add it to the matching domain proto file", lm.Name())
			continue
		}
		delete(domainMethods, string(lm.Name()))
		if lm.Input().FullName() != dm.Input().FullName() {
			t.Errorf("%s: input mismatch legacy=%s domain=%s", lm.Name(), lm.Input().FullName(), dm.Input().FullName())
		}
		if lm.Output().FullName() != dm.Output().FullName() {
			t.Errorf("%s: output mismatch legacy=%s domain=%s", lm.Name(), lm.Output().FullName(), dm.Output().FullName())
		}
		lVis, lRole := authOptions(lm)
		dVis, dRole := authOptions(dm)
		if lVis != dVis || lRole != dRole {
			t.Errorf("%s: auth annotation drift — legacy (visibility=%v role=%q) vs %s (visibility=%v role=%q); the copies must match",
				lm.Name(), lVis, lRole, dm.Parent().FullName(), dVis, dRole)
		}
	}
	for name, m := range domainMethods {
		t.Errorf("domain method %s.%s missing from the legacy ShortedStocksService — external API consumers only see the legacy service", m.Parent().FullName(), name)
	}
}
