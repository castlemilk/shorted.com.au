package main

import (
	"errors"
	"testing"

	chatv1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/chat/v1"
)

// recordingStream stands in for the Connect server stream. It keeps every frame
// sent to it, in order, and can be told to fail.
type recordingStream struct {
	frames []*chatv1.SendMessageResponse
	err    error
}

func (s *recordingStream) Send(frame *chatv1.SendMessageResponse) error {
	if s.err != nil {
		return s.err
	}
	s.frames = append(s.frames, frame)
	return nil
}

func TestAnnounceConversationSendsTheIDAsItsOwnTextlessFrame(t *testing.T) {
	stream := &recordingStream{}

	if err := announceConversation(stream, "conv-42"); err != nil {
		t.Fatalf("announceConversation: %v", err)
	}

	if len(stream.frames) != 1 {
		t.Fatalf("frames = %d, want exactly one", len(stream.frames))
	}
	frame := stream.frames[0]
	if frame.GetConversationId() != "conv-42" {
		t.Fatalf("conversation id = %q, want conv-42", frame.GetConversationId())
	}
	if frame.GetChunk() != "" || frame.GetIsComplete() || len(frame.GetToolCalls()) > 0 || len(frame.GetCitations()) > 0 {
		t.Fatalf("announcement carries more than the id: %+v", frame)
	}
}

func TestAnnounceConversationReportsAFailedSend(t *testing.T) {
	want := errors.New("client went away")
	stream := &recordingStream{err: want}

	if err := announceConversation(stream, "conv-42"); !errors.Is(err, want) {
		t.Fatalf("err = %v, want %v", err, want)
	}
}
