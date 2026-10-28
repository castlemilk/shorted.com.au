package shorts

// mcp_admin_ingest.go: whether the deployed housing-ingest admits a rig, for the
// housing crawl admin tools. shorted's allowlist row is one switch; the ingest's own
// deployed config is the other. The ingest admits a subject only when its revision
// enables it, lists the subject in HOUSING_INGEST_ALLOW_SUBJECTS, sets
// HOUSING_INGEST_ORG, and its config has no problem the ingest refuses to serve.
//
// The answer is read from the Cloud Run Admin API (services.get, then the latest ready
// revision), and parsed with the ingest's own config reader (ingest.ConfigFromEnv), so
// the rules cannot drift from the ingest that enforces them. It is an operator signal
// only. It never refuses or undoes a change.

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"slices"
	"strings"
	"sync"
	"time"

	"google.golang.org/api/option"
	"google.golang.org/api/run/v2"

	"github.com/castlemilk/shorted.com.au/services/pkg/log"
	"github.com/castlemilk/shorted.com.au/services/shorts/internal/ingest"
)

// EnvHousingIngestRunService names the housing-ingest Cloud Run service, as the full
// resource name projects/<p>/locations/<l>/services/<s>. Terraform sets it on shorts-api.
// Unset or malformed means the admission signal is unknown.
const EnvHousingIngestRunService = "HOUSING_INGEST_RUN_SERVICE"

const (
	// ingestAdmissionTTL bounds how stale a good read may be. An admin changes the config
	// by a deploy, which is minutes, so a minute is enough.
	ingestAdmissionTTL = time.Minute
	// ingestErrorTTL bounds how long a failed read is remembered. A failing read is not
	// retried on every row or call, but a fixed deployment is seen within this window.
	ingestErrorTTL = 10 * time.Second
	// ingestAdmissionTimeout bounds the Cloud Run reads. They run after the change, so a
	// slow read only delays the answer, never the write.
	ingestAdmissionTimeout = 5 * time.Second
)

var ingestRunServicePattern = regexp.MustCompile(`^projects/[a-z0-9-]+/locations/[a-z0-9-]+/services/[a-z0-9-]+$`)

// ingestAdmission reads and caches the deployed ingest config.
type ingestAdmission struct {
	resource string
	// endpoint overrides the Cloud Run API root. Tests only; empty in production.
	endpoint string
	now      func() time.Time

	mu  sync.Mutex
	svc *run.Service
	// A good read: the parsed config and ConfigFromEnv's problem, valid until expires.
	have    bool
	cfg     ingest.Config
	problem string
	expires time.Time
	// A failed read: remembered until errExpires, and never turned into an admission.
	lastErr    error
	errExpires time.Time
}

// newIngestAdmissionFromEnv returns the reader, or nil when the service is not named.
func newIngestAdmissionFromEnv(getenv func(string) string) *ingestAdmission {
	res := strings.TrimSpace(getenv(EnvHousingIngestRunService))
	if !ingestRunServicePattern.MatchString(res) {
		if res != "" {
			log.Errorf("admin housing crawl: %s is not a Cloud Run service resource name; the ingest admission signal is unknown", EnvHousingIngestRunService)
		}
		return nil
	}
	return &ingestAdmission{resource: res, now: time.Now}
}

// Snapshot reads the deployed config once and returns a function that answers for one
// subject at a time. A tool call takes one snapshot, however many rows it reports on, so
// a listing makes at most one read (the cache makes repeat reads cheaper still).
func (a *ingestAdmission) Snapshot(ctx context.Context) func(subject string) string {
	if a == nil {
		return func(string) string { return "unknown" }
	}
	cfg, problem, err := a.config(ctx)
	if err != nil {
		log.Warnf("admin housing crawl: reading the deployed housing-ingest config: %v", err)
		return func(string) string { return "unknown" }
	}
	return func(subject string) string { return admits(cfg, problem, subject) }
}

// admits applies the rule. "true" only when the ingest would serve the subject:
//   - it is enabled and HOUSING_INGEST_ORG is set;
//   - ConfigFromEnv reported no problem (the ingest answers Unavailable to every call when
//     it reports one, so a listed subject is still refused);
//   - no allowlist or deny entry is empty (the verifier refuses an empty entry); and
//   - the subject is listed.
//
// Otherwise "false": the config was read and does not admit it.
func admits(cfg ingest.Config, problem, subject string) string {
	if !cfg.Enabled || problem != "" || cfg.Org == "" {
		return "false"
	}
	for _, s := range cfg.AllowSubjects {
		if strings.TrimSpace(s) == "" {
			return "false"
		}
	}
	for _, k := range cfg.DenyKIDs {
		if strings.TrimSpace(k) == "" {
			return "false"
		}
	}
	if slices.Contains(cfg.AllowSubjects, subject) {
		return "true"
	}
	return "false"
}

// Admits reports one subject's admission from a fresh snapshot. Callers that report many
// subjects use Snapshot once instead.
func (a *ingestAdmission) Admits(ctx context.Context, subject string) string {
	return a.Snapshot(ctx)(subject)
}

// config returns the ingest's parsed configuration and its problem. A good read is cached
// for ingestAdmissionTTL. A failed read is cached for ingestErrorTTL and returned as an
// error, so the caller answers unknown; it is never served as a config. A read after either
// expires goes to Cloud Run, so an error followed by a success gives the success.
func (a *ingestAdmission) config(ctx context.Context) (ingest.Config, string, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	now := a.now()
	if a.have && now.Before(a.expires) {
		return a.cfg, a.problem, nil
	}
	if a.lastErr != nil && now.Before(a.errExpires) {
		return ingest.Config{}, "", a.lastErr
	}
	env, err := a.readEnv(ctx)
	if err != nil {
		a.have = false
		a.lastErr, a.errExpires = err, now.Add(ingestErrorTTL)
		return ingest.Config{}, "", err
	}
	// The ingest's own parser: the same code that decides what it admits and whether it serves.
	cfg, problem := ingest.ConfigFromEnv(func(k string) string { return env[k] })
	a.have, a.cfg, a.problem, a.expires = true, cfg, problem, now.Add(ingestAdmissionTTL)
	a.lastErr = nil
	return cfg, problem, nil
}

// readEnv returns the literal environment of the service's latest ready revision. Secret
// references carry no literal value here, so they are left out.
func (a *ingestAdmission) readEnv(ctx context.Context) (map[string]string, error) {
	ctx, cancel := context.WithTimeout(ctx, ingestAdmissionTimeout)
	defer cancel()
	if a.svc == nil {
		var opts []option.ClientOption
		if a.endpoint != "" {
			opts = append(opts, option.WithEndpoint(a.endpoint), option.WithoutAuthentication())
		}
		svc, err := run.NewService(context.Background(), opts...)
		if err != nil {
			return nil, err
		}
		a.svc = svc
	}
	s, err := a.svc.Projects.Locations.Services.Get(a.resource).Context(ctx).Do()
	if err != nil {
		return nil, err
	}
	if s.LatestReadyRevision == "" {
		return nil, errors.New("the service has no ready revision")
	}
	rev, err := a.svc.Projects.Locations.Services.Revisions.Get(s.LatestReadyRevision).Context(ctx).Do()
	if err != nil {
		return nil, err
	}
	if len(rev.Containers) != 1 {
		return nil, fmt.Errorf("expected one container in the revision, found %d", len(rev.Containers))
	}
	env := map[string]string{}
	for _, e := range rev.Containers[0].Env {
		if e != nil && e.ValueSource == nil {
			env[e.Name] = e.Value
		}
	}
	return env, nil
}
