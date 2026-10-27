package ingest

import (
	"context"
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

// pushesPerHour is the per-rig PushSweep ceiling, counted in process.
const pushesPerHour = 120

// Options are the service's dependencies.
type Options struct {
	// Config is the parsed environment, from ConfigFromEnv.
	Config Config
	// ConfigProblem is ConfigFromEnv's reason, or "". A non-empty problem keeps the
	// service mounted but unable to serve: every call answers Unavailable.
	ConfigProblem string
	// Pool is the store's database pool. Nil means the database is unavailable.
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
	// problem is why the service refuses every call, or "" when it serves.
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
		limiter: newPushLimiter(pushesPerHour, time.Hour, now),
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

// Problem returns why the service cannot serve, or "" when it can.
func (s *Service) Problem() string { return s.problem }

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
// fixed category; the reason stays in the startup log and in Health.
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

// ReportCycle records one rig cycle against crawl_run_status. See store.go.
func (s *Service) ReportCycle(ctx context.Context, req *connect.Request[pb.ReportCycleRequest]) (*connect.Response[pb.ReportCycleResponse], error) {
	if s.problem != "" {
		return nil, s.unavailable()
	}
	subject, err := s.rig(ctx)
	if err != nil {
		return nil, err
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

// Health is the readiness view: whether the service can serve and the verifier's
// key-cache status. It holds no token and no secret. The verifier's last error is
// a fixed reason string.
func (s *Service) Health() map[string]any {
	out := map[string]any{"enabled": s.cfg.Enabled}
	if !s.cfg.Enabled {
		return out
	}
	out["ready"] = s.problem == ""
	if s.problem != "" {
		out["problem"] = s.problem
	}
	if s.wa != nil {
		st := s.wa.Status()
		verifier := map[string]any{"key_count": st.KeyCount}
		if !st.LastSuccess.IsZero() {
			verifier["last_success"] = st.LastSuccess.UTC().Format(time.RFC3339)
		}
		if st.LastError != "" {
			verifier["last_error"] = st.LastError
			verifier["last_error_at"] = st.LastErrorAt.UTC().Format(time.RFC3339)
		}
		out["verifier"] = verifier
	}
	return out
}

// LogStartup writes the one-time startup line. A misconfiguration is an error,
// because the service is mounted and refusing calls.
func LogStartup(cfg Config, configProblem string) {
	switch {
	case configProblem != "":
		log.Errorf("housing ingest: %s; the ingest is mounted and answers Unavailable until this is fixed", configProblem)
	case cfg.Enabled:
		log.Infof("housing ingest enabled: issuer=%s audience=%s org=%s subjects=%d", cfg.Issuer, cfg.Audience, cfg.Org, len(cfg.AllowSubjects))
	}
}
