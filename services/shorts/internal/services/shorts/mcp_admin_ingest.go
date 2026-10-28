package shorts

// mcp_admin_ingest.go: whether the deployed housing-ingest admits a rig, for the
// housing crawl admin tools. shorted's allowlist row is one switch; the ingest's own
// config is the other. The ingest admits a subject only when the deployed revision
// lists it in HOUSING_INGEST_ALLOW_SUBJECTS and sets HOUSING_INGEST_ORG, so an
// "enabled" row alone admits nothing in production.
//
// The answer is read from the Cloud Run Admin API (services.get, then the latest ready
// revision), and parsed with the ingest's own config reader (ingest.ConfigFromEnv), so
// the rules cannot drift from the ingest that enforces them. It is cached briefly.
//
// It is an operator signal only. It never refuses or undoes a change.

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
	// ingestAdmissionTTL bounds how stale the deployed config may be. An admin changes it
	// by a deploy, which is minutes, so a minute is enough.
	ingestAdmissionTTL = time.Minute
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

	mu      sync.Mutex
	svc     *run.Service
	cfg     ingest.Config
	have    bool
	expires time.Time
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

// Admits reports whether the deployed ingest admits subject: "true" when the subject is
// listed in its allowlist, the ingest is enabled and HOUSING_INGEST_ORG is set; "false"
// when the config was read and does not admit it; "unknown" when it could not be read.
func (a *ingestAdmission) Admits(ctx context.Context, subject string) string {
	if a == nil {
		return "unknown"
	}
	cfg, err := a.config(ctx)
	if err != nil {
		log.Warnf("admin housing crawl: reading the deployed housing-ingest config: %v", err)
		return "unknown"
	}
	if cfg.Enabled && cfg.Org != "" && slices.Contains(cfg.AllowSubjects, subject) {
		return "true"
	}
	return "false"
}

// config returns the ingest's parsed configuration, cached for ingestAdmissionTTL. A read
// error is not cached, so a fixed deployment is seen on the next call.
func (a *ingestAdmission) config(ctx context.Context) (ingest.Config, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	now := a.now()
	if a.have && now.Before(a.expires) {
		return a.cfg, nil
	}
	env, err := a.readEnv(ctx)
	if err != nil {
		return ingest.Config{}, err
	}
	// The ingest's own parser: the same code that decides what it admits.
	cfg, _ := ingest.ConfigFromEnv(func(k string) string { return env[k] })
	a.cfg, a.have, a.expires = cfg, true, now.Add(ingestAdmissionTTL)
	return cfg, nil
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
