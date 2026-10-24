package main

import (
	"errors"
	"io"
	"slices"
	"strings"
	"testing"

	gax "github.com/googleapis/gax-go/v2"
	"google.golang.org/genproto/googleapis/rpc/status"
)

// Gemini streams a reply as one JSON array of messages. generative-ai-go reads
// that array through gax-go's ProtoJSONStream. Go 1.27 moved encoding/json v1
// onto v2, which broke gax-go before v2.26.1 (googleapis/gax-go#557): a complete
// reply failed with "invalid character ']' looking for beginning of value", or
// returned io.EOF before the first message. This test feeds the same array shape
// and requires both messages followed by a clean io.EOF. It must fail on the
// older gax-go and pass on v2.26.1 or later.
func TestGeminiProtoJSONStreamDecodesFullArray(t *testing.T) {
	body := `[{"message":"one"},{"message":"two"}]`
	stream := gax.NewProtoJSONStreamReader(
		io.NopCloser(strings.NewReader(body)),
		new(status.Status).ProtoReflect().Type(),
	)
	defer func() { _ = stream.Close() }()

	var got []string
	for {
		msg, err := stream.Recv()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			t.Fatalf("stream next after %d message(s): %v", len(got), err)
		}
		got = append(got, msg.(*status.Status).GetMessage())
	}
	if want := []string{"one", "two"}; !slices.Equal(got, want) {
		t.Fatalf("messages = %q, want %q", got, want)
	}
}
