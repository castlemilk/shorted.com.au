package ingest

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"connectrpc.com/connect"
	"github.com/jackc/pgx/v5/pgxpool"
	"google.golang.org/protobuf/types/known/timestamppb"

	pb "github.com/castlemilk/shorted.com.au/services/gen/proto/go/housingingest/v1"
	"github.com/castlemilk/shorted.com.au/services/gen/proto/go/housingingest/v1/housingingestv1connect"
	"github.com/castlemilk/shorted.com.au/services/pkg/log"
	"github.com/castlemilk/shorted.com.au/services/pkg/workloadauth"
)

// MaxRequestBytes is the body cap for every ingest call (4 MiB), enforced by the
// handler's read limit before the body is decoded.
const MaxRequestBytes = 4 << 20

// callsPerHour is the per-rig ceiling on PushSweep and ReportCycle together, counted
// in process.
const callsPerHour = 120

// Options are the service's dependencies.
type Options struct {
	// Config is the parsed environment, from ConfigFromEnv.
	Config Config
	// ConfigProblem is ConfigFromEnv's reason, or "". A non-empty problem keeps the
	// service mounted but unable to serve: every call answers Unavailable, and the
	// reason goes to the startup log, never to a caller.
	ConfigProblem string
	// Pool is the ingest's own database pool (OpenPool). Nil means the database is
	// unavailable, and every call answers Unavailable.
	Pool *pgxpool.Pool
	// Now is the clock. Nil means time.Now. Tests set it.
	Now func() time.Time
	// HTTPClient is the client the workload verifier fetches discovery and JWKS
	// with. Nil means the verifier's default. Tests point it at an httptest issuer.
	HTTPClient *http.Client
}

// Service implements CrawlIngestService.
type Service struct {
	cfg     Config
	pool    *pgxpool.Pool
	now     func() time.Time
	wa      *workloadauth.Verifier
	gate    *rigGate
	limiter *pushLimiter
	// problem is why the service refuses every call, or "" when it serves. It is
	// logged at startup and reported to operators through the health status only.
	problem string
}

// New builds the ingest service. It never blocks on the issuer: the verifier starts
// its first fetch in the background, so a BrandBrain outage at boot is the
// verifier's Unavailable on the calls it cannot answer, not a failed start.
func New(ctx context.Context, opts Options) *Service {
	now := opts.Now
	if now == nil {
		now = time.Now
	}
	s := &Service{
		cfg:     opts.Config,
		pool:    opts.Pool,
		now:     now,
		gate:    newRigGate(opts.Pool, now),
		limiter: newPushLimiter(callsPerHour, time.Hour, now),
		problem: opts.ConfigProblem,
	}
	if !opts.Config.Enabled || s.problem != "" {
		return s
	}
	if s.pool == nil {
		s.problem = "database unavailable"
		return s
	}
	v, err := workloadauth.NewVerifier(ctx, workloadauth.Config{
		Issuer:        opts.Config.Issuer,
		Audience:      opts.Config.Audience,
		Org:           opts.Config.Org,
		AllowSubjects: opts.Config.AllowSubjects,
		DenyKIDs:      opts.Config.DenyKIDs,
		HTTPClient:    opts.HTTPClient,
		Now:           now,
	})
	if err != nil {
		// The message names the config field; it never carries a secret.
		s.problem = "verifier config invalid: " + err.Error()
		return s
	}
	s.wa = v
	return s
}

// Handler returns the path and handler to mount. The handler carries its own
// interceptor chain: workload-identity auth, then the 4 MiB read limit. It has no
// CORS wrapper and none of the public API's interceptors.
func (s *Service) Handler() (string, http.Handler) {
	return housingingestv1connect.NewCrawlIngestServiceHandler(s,
		connect.WithInterceptors(authInterceptor(s.verifier(), s.gate, s.problem)),
		connect.WithReadMaxBytes(MaxRequestBytes),
	)
}

// verifier returns the token verifier, or nil when the service cannot verify.
func (s *Service) verifier() tokenVerifier {
	if s.wa == nil {
		return nil
	}
	return s.wa
}

// unavailable is the answer to a call the service cannot serve. The message is a
// fixed category; the reason is in the startup log and the health status.
func (s *Service) unavailable() error {
	if s.pool == nil {
		return connect.NewError(connect.CodeUnavailable, errors.New(msgDatabaseDown))
	}
	return connect.NewError(connect.CodeUnavailable, errors.New(msgMisconfigured))
}

// rig returns the verified subject. A call that reached a method without passing
// the interceptor is refused, never served as anonymous.
func (s *Service) rig(ctx context.Context) (string, error) {
	id, ok := rigFromContext(ctx)
	if !ok {
		return "", connect.NewError(connect.CodeUnauthenticated, errors.New(msgUnauthenticated))
	}
	return id.Subject, nil
}

// ProbeAuth verifies the caller and reports the contract this service accepts. It
// is not rate limited.
func (s *Service) ProbeAuth(ctx context.Context, _ *connect.Request[pb.ProbeAuthRequest]) (*connect.Response[pb.ProbeAuthResponse], error) {
	if s.problem != "" {
		return nil, s.unavailable()
	}
	subject, err := s.rig(ctx)
	if err != nil {
		return nil, err
	}
	return connect.NewResponse(&pb.ProbeAuthResponse{
		Subject:            subject,
		MinContractVersion: s.cfg.MinContractVersion,
		ServerTime:         timestamppb.New(s.now()),
	}), nil
}

// PushSweep applies one (suburb, source) sweep. See push.go.
func (s *Service) PushSweep(ctx context.Context, req *connect.Request[pb.PushSweepRequest]) (*connect.Response[pb.PushSweepResponse], error) {
	if s.problem != "" {
		return nil, s.unavailable()
	}
	subject, err := s.rig(ctx)
	if err != nil {
		return nil, err
	}
	if allowed, retry := s.limiter.allow(subject); !allowed {
		return nil, rateLimitError(retry)
	}
	resp, err := s.pushSweep(ctx, subject, req.Msg)
	if err != nil {
		return nil, err
	}
	return connect.NewResponse(resp), nil
}

// ReportCycle records one rig cycle against crawl_run_status. It shares the
// per-rig call limit with PushSweep. See store.go.
func (s *Service) ReportCycle(ctx context.Context, req *connect.Request[pb.ReportCycleRequest]) (*connect.Response[pb.ReportCycleResponse], error) {
	if s.problem != "" {
		return nil, s.unavailable()
	}
	subject, err := s.rig(ctx)
	if err != nil {
		return nil, err
	}
	if allowed, retry := s.limiter.allow(subject); !allowed {
		return nil, rateLimitError(retry)
	}
	if err := validateCycle(req.Msg); err != nil {
		return nil, err
	}
	if err := s.recordCycle(ctx, subject, req.Msg); err != nil {
		log.Warnf("housing ingest: ReportCycle write failed for %s: %v", subject, err)
		return nil, connect.NewError(connect.CodeUnavailable, errors.New(msgDatabaseDown))
	}
	return connect.NewResponse(&pb.ReportCycleResponse{Recorded: true}), nil
}

// HealthStatus is the readiness word the health endpoint returns: "disabled",
// "ready" or "unavailable". It says nothing about why. The reason is logged at
// startup (LogStartup), so a public endpoint never carries a config problem.
func (s *Service) HealthStatus() string {
	switch {
	case !s.cfg.Enabled:
		return "disabled"
	case s.problem != "":
		return "unavailable"
	default:
		return "ready"
	}
}

// HealthHandler serves the readiness word as JSON. It is safe to expose publicly: it
// carries no configuration text, no verifier error and no key material.
func HealthHandler(s *Service) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(map[string]string{"status": s.HealthStatus()})
	})
}

// LogStartup writes the one-time startup line. A misconfiguration is an error,
// because the service is mounted and refusing calls. This is where the reason goes.
func LogStartup(cfg Config, configProblem string) {
	switch {
	case configProblem != "":
		log.Errorf("housing ingest: %s; the ingest is mounted and answers Unavailable until this is fixed", configProblem)
	case cfg.Enabled:
		log.Infof("housing ingest enabled: issuer=%s audience=%s org=%s subjects=%d", cfg.Issuer, cfg.Audience, cfg.Org, len(cfg.AllowSubjects))
	}
}
