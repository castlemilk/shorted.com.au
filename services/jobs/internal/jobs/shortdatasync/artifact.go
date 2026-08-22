package shortdatasync

// artifact.go publishes a VALIDATION run's report as a durable object in the
// job's own GCS bucket.
//
// # Why an object and not the log line
//
// The first cut of this feature retrieved the report from Cloud Logging: the
// job printed one prefixed JSON line and the admin API read that ONE
// execution's log entries back. That worked, and it is still how a human
// debugs a run by eye — but it was the wrong retrieval channel for a service:
//
//   - It needed roles/logging.viewer, and log access is only grantable at the
//     PROJECT level. The CI deploy service account can read a project IAM
//     policy but cannot set one (setIamPolicy 403), so the grant could not be
//     applied by the pipeline at all — it broke every `terraform apply` in the
//     repo, not just this feature's. Bucket IAM, by contrast, is writable by
//     the deploy SA, because the deploy SA owns the bucket.
//   - It coupled a product feature to log RETENTION. A report older than the
//     bucket's log sink is simply gone.
//   - It made the payload's shape load-bearing: a single line, because Cloud
//     Logging splits stdout per newline, parsed back out of unstructured log
//     chatter. An object has none of those constraints.
//
// So the report is written to gs://<bucket>/validations/<execution>.json, and
// the API reads exactly that key. The stdout line is KEPT — it costs nothing
// and it is what an operator greps when they are already looking at logs.
//
// # The invariant
//
// A plain `-shadow` run (the parity path) writes ABSOLUTELY NOTHING: no
// object, no client, no network call. The artifact is written only when
// `-stocks` is also set, which is the same gate that produces the `stocks`
// section of the summary. publishValidationArtifact enforces this itself
// rather than trusting its caller, and TestPlainShadowWritesNoArtifact pins
// it.

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"regexp"
	"time"

	"cloud.google.com/go/storage"
	"github.com/castlemilk/shorted.com.au/services/jobs/internal/platform"
)

// validationObjectPrefix is the bucket "directory" validation reports live
// under.
//
// This literal, and the `<prefix><execution>.json` layout below, are the
// CROSS-MODULE CONTRACT with the reader in services/shorts/internal/jobmonitor
// (validationObjectPath there). The two are separate Go modules and cannot
// share a constant; both sides have a test pinning the exact path. Change one,
// change the other.
const validationObjectPrefix = "validations/"

// validationArtifactContentType is set on the object so a browser or `gcloud
// storage cat` renders it rather than downloading it.
const validationArtifactContentType = "application/json"

// bucketEnvVar names the bucket. The SAME variable name is read by the shorts
// API (see terraform/modules/shorts-api), because they must agree on one
// bucket and a second name would be a second thing to get wrong.
const bucketEnvVar = "SHORTS_DATA_BUCKET"

// artifactWriteTimeout bounds the upload. The payload is tens of kilobytes at
// most; if it has not landed in 30s the run should report that and finish,
// never hang.
const artifactWriteTimeout = 30 * time.Second

// executionNamePattern is the Cloud Run execution short-name shape. The
// execution id arrives from the environment rather than from a caller, but it
// becomes an object KEY, so it is validated to the same standard as anything
// else that reaches a resource path.
var executionNamePattern = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$`)

// validationArtifact records where the report was published — or why it was
// not. It rides in the summary so the stdout line is self-describing: an
// operator reading the log sees the object's address, and sees the failure if
// there was one.
//
// Present ONLY on a validation run (`omitempty` on the summary field), so the
// plain-shadow parity artefact stays byte-for-byte unchanged.
type validationArtifact struct {
	// Bucket / Object / URI are set BEFORE the upload is attempted, so the
	// stored object contains its own address.
	Bucket string `json:"bucket,omitempty"`
	Object string `json:"object,omitempty"`
	URI    string `json:"uri,omitempty"`
	// Error is set only when the upload failed. A stored object therefore never
	// carries one, which is the truthful reading: if it stored, it worked.
	Error string `json:"error,omitempty"`
	// Skipped explains a write that was never attempted (no bucket configured,
	// not running on Cloud Run). Distinct from Error: nothing went wrong.
	Skipped string `json:"skipped,omitempty"`
}

// validationObjectPath is the object key for one execution's report.
func validationObjectPath(execution string) string {
	return validationObjectPrefix + execution + ".json"
}

// objectWriter is the blob side channel. An interface so the publish path is
// testable without GCS — and so a test can assert that a plain shadow run
// never calls it.
type objectWriter interface {
	WriteObject(ctx context.Context, bucket, object, contentType string, body []byte) error
}

// gcsObjectWriter is the live implementation. The client is created lazily, on
// the one code path that uploads, so a plain shadow run never even constructs
// one.
type gcsObjectWriter struct{}

func (gcsObjectWriter) WriteObject(ctx context.Context, bucket, object, contentType string, body []byte) error {
	client, err := storage.NewClient(ctx)
	if err != nil {
		return fmt.Errorf("create gcs client: %w", err)
	}
	defer func() { _ = client.Close() }()

	w := client.Bucket(bucket).Object(object).NewWriter(ctx)
	w.ContentType = contentType
	if _, err := w.Write(body); err != nil {
		_ = w.Close()
		return fmt.Errorf("write gs://%s/%s: %w", bucket, object, err)
	}
	if err := w.Close(); err != nil {
		return fmt.Errorf("close gs://%s/%s: %w", bucket, object, err)
	}
	return nil
}

// publishValidationArtifact writes the summary to GCS and records the outcome
// on the summary itself.
//
// FAIL SOFT by construction: it returns nothing. Every failure mode — no
// bucket, no execution id, a refused upload — annotates sum.Artifact, logs,
// and lets the run finish successfully. A validation is a diagnostic; losing
// its durable copy must not turn into a red job that then needs diagnosing.
//
// The gate is `len(cfg.stocks) > 0`, checked HERE and not merely at the call
// site: the parity path's "writes nothing" property is the one thing in this
// package worth enforcing twice.
func publishValidationArtifact(
	ctx context.Context,
	cfg config,
	sum *shadowSummary,
	w objectWriter,
	bucket, execution string,
) {
	if sum == nil || len(cfg.stocks) == 0 {
		return
	}
	art := &validationArtifact{}
	sum.Artifact = art

	switch {
	case bucket == "":
		art.Skipped = fmt.Sprintf("%s is not set; the report was printed but not stored", bucketEnvVar)
	case execution == "":
		art.Skipped = "CLOUD_RUN_EXECUTION is not set (not a Cloud Run execution); the report has no addressable key"
	case !executionNamePattern.MatchString(execution):
		art.Skipped = fmt.Sprintf("CLOUD_RUN_EXECUTION %q is not a Cloud Run execution name", execution)
	}
	if art.Skipped != "" {
		log.Printf("⚠️  validation report not stored: %s", art.Skipped)
		return
	}

	object := validationObjectPath(execution)
	art.Bucket = bucket
	art.Object = object
	art.URI = "gs://" + bucket + "/" + object

	// Marshalled with the address already set, so the stored object tells you
	// where it lives.
	body, err := json.Marshal(sum)
	if err != nil {
		art.Error = err.Error()
		log.Printf("⚠️  could not encode the validation report: %v", err)
		return
	}

	writeCtx, cancel := context.WithTimeout(ctx, artifactWriteTimeout)
	defer cancel()
	if err := w.WriteObject(writeCtx, bucket, object, validationArtifactContentType, body); err != nil {
		art.Error = err.Error()
		log.Printf("⚠️  could not store the validation report at %s: %v", art.URI, err)
		return
	}
	log.Printf("📦 validation report stored at %s", art.URI)
}

// validationBucket is the configured bucket name ("" when unset).
func validationBucket() string { return platform.GetEnv(bucketEnvVar, "") }
