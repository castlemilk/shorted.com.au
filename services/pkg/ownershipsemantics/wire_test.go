package ownershipsemantics_test

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"strings"
	"testing"

	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	semantics "github.com/castlemilk/shorted.com.au/services/pkg/ownershipsemantics"
	"google.golang.org/protobuf/encoding/protowire"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protoreflect"
)

func wireFixture(t *testing.T) semantics.Input {
	t.Helper()
	raw, err := os.ReadFile("testdata/wire_roundtrip.json")
	if err != nil {
		t.Fatal(err)
	}
	in, err := semantics.DecodeInput(raw)
	if err != nil {
		t.Fatal(err)
	}
	return in
}

func TestWireRoundTripPreservesImmutableObservation(t *testing.T) {
	in := wireFixture(t)
	before, err := semantics.Prepare(in)
	if err != nil {
		t.Fatal(err)
	}
	wire, err := semantics.ToProto(in)
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := proto.Marshal(wire)
	if err != nil {
		t.Fatal(err)
	}
	decoded := new(shortsv1alpha1.OwnershipSemanticInput)
	if err := proto.Unmarshal(encoded, decoded); err != nil {
		t.Fatal(err)
	}
	got, err := semantics.FromProto(decoded)
	if err != nil {
		t.Fatal(err)
	}
	after, err := semantics.Prepare(got)
	if err != nil {
		t.Fatal(err)
	}
	if before.RevisionID != after.RevisionID || before.DisclosureID != after.DisclosureID || before.PayloadSHA256 != after.PayloadSHA256 {
		t.Fatalf("wire roundtrip changed immutable identity or evidence: before=%s after=%s", before.PayloadSHA256, after.PayloadSHA256)
	}
	if got.PublishedAt != "" || got.PublicationEligible {
		t.Fatal("wire conversion invented a timestamp or publication eligibility")
	}
	if got.Measurements[1].Votes.Value != "9007199254740993" || got.Measurements[1].Percent.Value != "2.000000000000000001" {
		t.Fatal("wire conversion lost exact integer or decimal precision")
	}
	if got.Measurements[3].Percent.Value != "0.0000" || got.Measurements[4].Percent.Status != semantics.Unknown || got.Measurements[4].Percent.Value != "" {
		t.Fatal("wire conversion collapsed reported zero and unknown")
	}
}

func TestWireFixtureHashesAreCapturedBytes(t *testing.T) {
	in := wireFixture(t)
	for _, tc := range []struct{ path, want string }{
		{"testdata/wire_source.txt", in.Source.SHA256},
		{"testdata/wire_annexure.txt", in.Annexures[0].Evidence[0].SourceSHA256},
	} {
		raw, err := os.ReadFile(tc.path)
		if err != nil {
			t.Fatal(err)
		}
		sum := sha256.Sum256(raw)
		if hex.EncodeToString(sum[:]) != tc.want {
			t.Fatalf("%s does not match its captured-byte hash", tc.path)
		}
	}
}

func TestWireRejectsInvalidObservations(t *testing.T) {
	cases := []struct {
		name   string
		mutate func(*shortsv1alpha1.OwnershipSemanticInput)
	}{
		{"publication", func(in *shortsv1alpha1.OwnershipSemanticInput) { in.PublicationEligible = true }},
		{"unknown with numeric value", func(in *shortsv1alpha1.OwnershipSemanticInput) { in.Measurements[0].Percent.Status = "unknown" }},
		{"absent status", func(in *shortsv1alpha1.OwnershipSemanticInput) { in.Measurements[0].Percent = nil }},
		{"uncaptured source", func(in *shortsv1alpha1.OwnershipSemanticInput) { in.Source.HashStatus = "not_captured" }},
		{"unsupported contract", func(in *shortsv1alpha1.OwnershipSemanticInput) { in.ContractVersion = "future.v2" }},
		{"out of range slot", func(in *shortsv1alpha1.OwnershipSemanticInput) { in.DisclosureSlot = 2147483647 }},
		{"negative page", func(in *shortsv1alpha1.OwnershipSemanticInput) { in.ContextEvidence[0].Page = -1 }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			wire, err := semantics.ToProto(wireFixture(t))
			if err != nil {
				t.Fatal(err)
			}
			tc.mutate(wire)
			if _, err := semantics.FromProto(wire); err == nil {
				t.Fatal("invalid wire observation was accepted")
			}
		})
	}
	if _, err := semantics.FromProto(nil); err == nil {
		t.Fatal("nil wire input was accepted")
	}
	in := wireFixture(t)
	in.ContextEvidence[0].Page = 2147483647
	if _, err := semantics.ToProto(in); err == nil {
		t.Fatal("out-of-range domain page was accepted")
	}
}

func TestWireUnknownFieldsAreNeverDiscarded(t *testing.T) {
	cases := []struct {
		name    string
		message func(*shortsv1alpha1.OwnershipSemanticInput) protoreflect.Message
	}{
		{"root", func(in *shortsv1alpha1.OwnershipSemanticInput) protoreflect.Message { return in.ProtoReflect() }},
		{"nested value", func(in *shortsv1alpha1.OwnershipSemanticInput) protoreflect.Message {
			return in.Measurements[0].Percent.ProtoReflect()
		}},
		{"repeated evidence", func(in *shortsv1alpha1.OwnershipSemanticInput) protoreflect.Message {
			return in.Interests[0].Evidence[0].ProtoReflect()
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			wire, err := semantics.ToProto(wireFixture(t))
			if err != nil {
				t.Fatal(err)
			}
			unknown := protowire.AppendTag(nil, 1000, protowire.BytesType)
			unknown = protowire.AppendString(unknown, "future source metadata")
			tc.message(wire).SetUnknown(unknown)
			if _, err := semantics.FromProto(wire); err == nil || !strings.Contains(err.Error(), "unknown protobuf fields") {
				t.Fatalf("expected explicit compatibility error, got %v", err)
			}
		})
	}
}
