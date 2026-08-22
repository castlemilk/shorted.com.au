package shortdatasync

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"
)

// recordingWriter captures every upload — and, crucially, records that it was
// called at all.
type recordingWriter struct {
	calls       int
	bucket      string
	object      string
	contentType string
	body        []byte
	err         error
}

func (w *recordingWriter) WriteObject(_ context.Context, bucket, object, contentType string, body []byte) error {
	w.calls++
	w.bucket, w.object, w.contentType = bucket, object, contentType
	w.body = append([]byte(nil), body...)
	return w.err
}

func validationSummary(t *testing.T) shadowSummary {
	t.Helper()
	sum := newShadowSummary(time.Date(2026, 8, 22, 1, 2, 3, 0, time.UTC), 7)
	rep := buildStocksReport([]string{"BHP"}, nil, map[string]shortsRow{})
	sum.Stocks = &rep
	return sum
}

// TestPlainShadowWritesNoArtifact is THE invariant: the parity path writes
// absolutely nothing. `-stocks` is the only thing that turns the artifact on,
// and the gate is enforced inside publishValidationArtifact, not merely by its
// caller — so this holds even if a future caller forgets.
func TestPlainShadowWritesNoArtifact(t *testing.T) {
	sum := newShadowSummary(time.Now(), 7)
	w := &recordingWriter{}

	publishValidationArtifact(context.Background(), config{shadow: true}, &sum, w,
		"shorted-short-selling-data-prod", "shorts-data-sync-abcde")

	if w.calls != 0 {
		t.Fatalf("a plain shadow run must write no object, got %d write(s) to %s", w.calls, w.object)
	}
	if sum.Artifact != nil {
		t.Fatalf("a plain shadow run must carry no artifact section: %+v", sum.Artifact)
	}
	var buf strings.Builder
	if err := sum.writeJSON(&buf); err != nil {
		t.Fatalf("writeJSON: %v", err)
	}
	if strings.Contains(buf.String(), `"artifact"`) {
		t.Fatalf("the parity artefact must stay byte-compatible:\n%s", buf.String())
	}
}

// TestValidationArtifactObjectPath pins the CROSS-MODULE contract. The reader
// lives in services/shorts/internal/jobmonitor and carries its own copy of this
// layout; change one, change the other.
func TestValidationArtifactObjectPath(t *testing.T) {
	if got := validationObjectPath("shorts-data-sync-v4l1d"); got != "validations/shorts-data-sync-v4l1d.json" {
		t.Fatalf("object path = %q — update services/shorts/internal/jobmonitor/validate.go too", got)
	}
	if validationObjectPrefix != "validations/" {
		t.Fatalf("prefix changed to %q — the jobmonitor reader carries a copy", validationObjectPrefix)
	}
}

func TestValidationArtifactWritesTheReport(t *testing.T) {
	sum := validationSummary(t)
	w := &recordingWriter{}

	publishValidationArtifact(context.Background(), config{shadow: true, stocks: []string{"BHP"}}, &sum, w,
		"shorted-short-selling-data-prod", "shorts-data-sync-v4l1d")

	if w.calls != 1 {
		t.Fatalf("want exactly one upload, got %d", w.calls)
	}
	if w.bucket != "shorted-short-selling-data-prod" {
		t.Fatalf("bucket = %q", w.bucket)
	}
	if w.object != "validations/shorts-data-sync-v4l1d.json" {
		t.Fatalf("object = %q", w.object)
	}
	if w.contentType != "application/json" {
		t.Fatalf("contentType = %q", w.contentType)
	}
	if sum.Artifact == nil || sum.Artifact.Error != "" || sum.Artifact.Skipped != "" {
		t.Fatalf("artifact = %+v", sum.Artifact)
	}
	if sum.Artifact.URI != "gs://shorted-short-selling-data-prod/validations/shorts-data-sync-v4l1d.json" {
		t.Fatalf("uri = %q", sum.Artifact.URI)
	}

	// The stored body is the whole summary, and it carries its own address.
	var back shadowSummary
	if err := json.Unmarshal(w.body, &back); err != nil {
		t.Fatalf("stored object must parse as a summary: %v", err)
	}
	if back.Mode != "shadow" || back.SchemaVersion != shadowSchemaVersion || back.Stocks == nil {
		t.Fatalf("stored object lost the contract: %+v", back)
	}
	if back.Artifact == nil || back.Artifact.Object != w.object {
		t.Fatalf("stored object must record its own address: %+v", back.Artifact)
	}
	if back.Artifact.Error != "" {
		t.Fatalf("a stored object can never carry a write error: %q", back.Artifact.Error)
	}
}

// TestValidationArtifactFailsSoft: a refused upload annotates the summary and
// lets the run finish. A diagnostic must not need diagnosing.
func TestValidationArtifactFailsSoft(t *testing.T) {
	sum := validationSummary(t)
	w := &recordingWriter{err: errors.New("storage: permission denied")}

	publishValidationArtifact(context.Background(), config{shadow: true, stocks: []string{"BHP"}}, &sum, w,
		"bucket", "shorts-data-sync-v4l1d")

	if sum.Artifact == nil || !strings.Contains(sum.Artifact.Error, "permission denied") {
		t.Fatalf("the failure must be reported in the summary: %+v", sum.Artifact)
	}
	// ...and it still reaches the operator on stdout.
	var buf strings.Builder
	if err := sum.writeValidationLine(&buf); err != nil {
		t.Fatalf("writeValidationLine: %v", err)
	}
	if !strings.Contains(buf.String(), "permission denied") {
		t.Fatalf("the stdout line must carry the artifact failure:\n%s", buf.String())
	}
}

// TestValidationArtifactSkipsWithoutCoordinates covers the two "nothing went
// wrong, there was just nowhere to put it" cases — reported as Skipped, never
// as an Error, and never as an upload.
func TestValidationArtifactSkipsWithoutCoordinates(t *testing.T) {
	for _, tc := range []struct {
		name      string
		bucket    string
		execution string
		want      string
	}{
		{"no bucket", "", "shorts-data-sync-v4l1d", "SHORTS_DATA_BUCKET"},
		{"no execution", "bucket", "", "CLOUD_RUN_EXECUTION"},
		{"bogus execution", "bucket", "../../etc/passwd", "CLOUD_RUN_EXECUTION"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			sum := validationSummary(t)
			w := &recordingWriter{}
			publishValidationArtifact(context.Background(),
				config{shadow: true, stocks: []string{"BHP"}}, &sum, w, tc.bucket, tc.execution)

			if w.calls != 0 {
				t.Fatalf("no upload may be attempted, got %d", w.calls)
			}
			if sum.Artifact == nil || !strings.Contains(sum.Artifact.Skipped, tc.want) {
				t.Fatalf("artifact = %+v, want a Skipped mentioning %s", sum.Artifact, tc.want)
			}
			if sum.Artifact.Error != "" {
				t.Fatalf("a skipped write is not an error: %q", sum.Artifact.Error)
			}
			if sum.Artifact.Object != "" {
				t.Fatalf("a skipped write must not claim an object key: %q", sum.Artifact.Object)
			}
		})
	}
}
