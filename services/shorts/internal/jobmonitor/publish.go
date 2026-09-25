package jobmonitor

// publish.go adds a second constrained override-run: publish ONE hand-written
// article from content/news to /news.
//
// It follows validate.go's shape exactly, for the same reasons (read that
// file's header first):
//
//  1. IAM: roles/run.developer (the role carrying runWithOverrides) is granted
//     on exactly ONE job, shorted-news-publish — see
//     terraform/environments/prod/main.tf. The job is NOT in the fleet-wide
//     run.invoker map, so "Run now" cannot execute it with its deployed
//     (harmless, read-only) args either.
//  2. The argv is BUILT HERE from a slug validated against slugPattern. A
//     caller supplies a slug and one boolean; there is no path by which caller
//     text becomes an argv element other than as the value of --slug=, and
//     only after it has matched a pattern that cannot express a flag, a path
//     separator or whitespace.
//
// The article BODY never crosses this API. The job image bakes content/news
// in at build time, so what can be published is exactly what was merged to
// main; a caller can choose WHICH merged article, never WHAT it says.
//
// Unlike a validation run, a publish WRITES (editorial_takes, GCS images, a
// revalidation ping) and costs money (~$0.32 of image generation), so the
// already-running guard DOES apply: a double-click must not pay twice or race
// two image sets onto one slug.

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"
)

// PublishJobName is the ONLY job the publish endpoint can execute. A constant,
// for the same reason as ValidationJobName: the IAM elevation is scoped to this
// one job and the endpoint must not be able to aim elsewhere.
const PublishJobName = "shorted-news-publish"

// publishSubcommand is the take-writer CLI command (the image ENTRYPOINT is
// `npx tsx src/index.ts`, so args[0] is the subcommand).
const publishSubcommand = "publish-content"

// maxSlugLength and slugPattern mirror scripts/take-writer/src/import-mdx.ts
// (MAX_SLUG_LENGTH, SLUG_PATTERN). They are separate languages and cannot share
// a constant; both sides have tests. Change one, change the other.
const maxSlugLength = 120

var slugPattern = regexp.MustCompile(`^[a-z0-9]+(?:-[a-z0-9]+)*$`)

// ErrInvalidSlug: the requested slug is empty, too long, or not kebab-case.
var ErrInvalidSlug = errors.New("jobmonitor: invalid article slug")

// PublishRequest is a request to publish one article. Note what is NOT here:
// no job name, no region, no arguments, no article content.
type PublishRequest struct {
	Slug string
	// SkipImages publishes without generating images (the hero falls back to
	// the article's cover). Images are ON by default.
	SkipImages bool
	// Force overrides the already-running guard.
	Force bool
	// Actor is the admin identity, for the audit log only.
	Actor string
}

// PublishRun describes the execution that was created.
type PublishRun struct {
	Job           string `json:"job"`
	Region        string `json:"region"`
	ExecutionName string `json:"executionName"`
	Slug          string `json:"slug"`
	// Args is the argv this service constructed. Output, never input.
	Args []string `json:"args"`
	// URL is where the article will be once the run succeeds.
	URL string `json:"url"`
}

// PublishStatus is the polled state of a publish run.
type PublishStatus struct {
	ExecutionName string `json:"executionName"`
	// Status is "running" | "succeeded" | "failed" | "unknown".
	Status      string `json:"status"`
	StartedAt   string `json:"startedAt,omitempty"`
	CompletedAt string `json:"completedAt,omitempty"`
	LogUri      string `json:"logUri,omitempty"`
	Message     string `json:"message,omitempty"`
}

// NormalizeSlug validates a caller-supplied slug. It trims surrounding
// whitespace and nothing else: a slug is an identifier, so "US-Bond" is
// rejected rather than silently lower-cased into a different article.
func NormalizeSlug(in string) (string, error) {
	slug := strings.TrimSpace(in)
	if slug == "" {
		return "", fmt.Errorf("%w: no slug supplied", ErrInvalidSlug)
	}
	if len(slug) > maxSlugLength {
		return "", fmt.Errorf("%w: %d characters (max %d)", ErrInvalidSlug, len(slug), maxSlugLength)
	}
	if !slugPattern.MatchString(slug) {
		return "", fmt.Errorf("%w: %q is not lowercase kebab-case", ErrInvalidSlug, slug)
	}
	return slug, nil
}

// publishArgs builds the argv. Pure and total: given a slug that passed
// NormalizeSlug, the result can only ever be a publish-content run for it.
func publishArgs(slug string, skipImages bool) []string {
	args := []string{publishSubcommand, "--slug=" + slug}
	if skipImages {
		args = append(args, "--no-images")
	}
	return args
}

// publishURL is the public page the article lands on.
func publishURL(slug string) string {
	return "https://shorted.com.au/news/" + slug
}

// RunPublish starts a publish run for one merged article.
//
// Validation order: slug (400) before project config (503) before job
// resolution (404/409) before the running guard (409, forceable).
func (c *Collector) RunPublish(ctx context.Context, req PublishRequest) (*PublishRun, error) {
	slug, err := NormalizeSlug(req.Slug)
	if err != nil {
		return nil, err
	}
	target, err := c.resolveNamedTarget(ctx, PublishJobName)
	if err != nil {
		return nil, err
	}
	if isRunning(target) && !req.Force {
		name := firstNonEmpty(target.RunningExecution, target.ExecutionName)
		started := firstNonEmpty(target.RunningStartedAt, target.LastRunAt)
		return nil, &AlreadyRunningError{
			Job:           target.Name,
			ExecutionName: name,
			StartedAt:     started,
			Age:           ageSince(started, time.Now().UTC()),
		}
	}

	overrider, ok := c.overrideRunner()
	if !ok {
		return nil, ErrOverridesUnsupported
	}
	args := publishArgs(slug, req.SkipImages)
	execName, err := overrider.RunWithArgs(ctx, c.cfg.ProjectID, target.Region, target.Name, args)
	if err != nil {
		return nil, err
	}
	c.Invalidate()

	return &PublishRun{
		Job:           target.Name,
		Region:        target.Region,
		ExecutionName: execName,
		Slug:          slug,
		Args:          args,
		URL:           publishURL(slug),
	}, nil
}

// PublishResult polls one publish execution. The job has no report artifact:
// its outcome IS the execution's outcome (a failed image generation exits
// non-zero and leaves the article a draft), so the execution state and its log
// link are the whole answer.
func (c *Collector) PublishResult(ctx context.Context, executionName string) (*PublishStatus, error) {
	execName, err := normalizeExecutionName(executionName)
	if err != nil {
		return nil, err
	}
	target, err := c.resolveNamedTarget(ctx, PublishJobName)
	if err != nil {
		return nil, err
	}
	reader := c.execReader
	if reader == nil {
		reader = cloudRunExecutionReader{}
	}
	exec, err := reader.Execution(ctx, c.cfg.ProjectID, target.Region, target.Name, execName)
	if err != nil {
		return nil, err
	}

	st := &PublishStatus{ExecutionName: execName, Status: executionState(exec)}
	if exec != nil {
		st.StartedAt = exec.StartTime
		st.CompletedAt = exec.CompletionTime
		st.LogUri = exec.LogUri
	}
	if st.Status == "failed" {
		st.Message = executionFailureMessage(exec)
	}
	return st, nil
}
