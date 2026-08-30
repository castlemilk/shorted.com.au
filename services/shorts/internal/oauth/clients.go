package oauth

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/castlemilk/shorted.com.au/services/pkg/log"
	"github.com/castlemilk/shorted.com.au/services/shorts/internal/mcp"
)

// How a client comes to exist, and why there are two ways.
//
// The 2026-07-28 MCP protocol revision PREFERS Client ID Metadata Documents:
// the client_id IS an https URL, and the authorization server fetches the
// client's own metadata from it. Nothing is registered in advance, nothing
// expires, and a client that changes its redirect URIs publishes the change
// itself. RFC 7591 dynamic client registration is deprecated in that revision
// but kept here because Claude and ChatGPT still use it.
//
// The two paths have opposite risk profiles and are defended differently:
//
//   - CIMD makes this server issue an OUTBOUND request to a URL an
//     unauthenticated caller chose. That is server-side request forgery by
//     construction, so every bound below (scheme, address space, redirects,
//     size, time, cache) exists to keep that request from becoming a probe of
//     our own network.
//   - DCR makes an unauthenticated caller WRITE a row. That is junk and quota
//     abuse, so it is rate limited per IP, capped per IP, and swept.
const (
	// SourceDCR and SourceCIMD are the two values migration 000116's
	// registration_source CHECK constraint accepts.
	SourceDCR  = "dcr"
	SourceCIMD = "cimd"
)

// Bounds on the CIMD fetch. Each one is a cap on what a hostile client_id can
// cost us, and none of them is defensive style: this fetch is attacker-directed.
const (
	// DefaultCIMDTimeout bounds the WHOLE fetch — connect, TLS, headers and
	// body. A slow-loris document that dribbles bytes forever would otherwise
	// pin a goroutine and a connection for as long as the attacker likes.
	DefaultCIMDTimeout = 5 * time.Second
	// DefaultCIMDMaxBytes is the response cap. A metadata document is a few
	// hundred bytes; 64 KiB is generous and still bounds memory per fetch.
	DefaultCIMDMaxBytes int64 = 64 << 10
	// DefaultCIMDSuccessTTL is how long a valid document is trusted. Bounded
	// rather than permanent so a client that rotates its redirect URIs recovers
	// without an operator.
	DefaultCIMDSuccessTTL = time.Hour
	// DefaultCIMDFailureTTL caches REFUSALS. Without it, a hostile client_id is
	// a free amplifier: every grant attempt becomes an outbound request we pay
	// for. With it, the cost of pointing us at a URL is one fetch per five
	// minutes per URL.
	DefaultCIMDFailureTTL = 5 * time.Minute
	// DefaultCIMDCacheEntries bounds the cache so a stream of distinct hostile
	// URLs cannot grow it without limit.
	DefaultCIMDCacheEntries = 2048
)

// Registration limits. These are per PROCESS, exactly like the per-minute tier
// limiter in pkg/ratelimit: there is no IP column in migration 000116 and no
// shared counter store, so with N instances the effective ceiling is up to N
// times these numbers. That is accepted for the same reason it is accepted
// there — this is abuse shaping, and the tier-blind Cloudflare bucket is the
// hard ceiling above it.
const (
	// DefaultRegistrationsPerIPPerHour counts ATTEMPTS, not successes. Counting
	// successes would let an attacker hammer the endpoint for free by sending
	// invalid metadata every time.
	DefaultRegistrationsPerIPPerHour = 10
	// DefaultRegistrationsPerIPPerDay is the total cap the plan asks for: a
	// single caller cannot mint an unbounded number of rows however patiently
	// it spaces them out.
	DefaultRegistrationsPerIPPerDay = 50
	// maxRegistrationIPs bounds the limiter's own state. See the note at
	// allow() for why a full table refuses rather than failing open.
	maxRegistrationIPs = 10000
)

// UnusedClientTTL is how long a registered client may sit unused before the
// sweep removes it.
//
// Thirty days is not arbitrary: it is RefreshTokenTTL. A client whose last use
// is older than the longest-lived credential it could hold has, by
// construction, no live grant left — which is the second half of why deleting
// it is safe (the first half is the sweep's own NOT EXISTS guards; see
// DeleteUnusedClients).
const UnusedClientTTL = RefreshTokenTTL

// Registration metadata bounds. A registration request is unauthenticated
// input that becomes a row, so every list and string it carries is capped.
const (
	maxRedirectURIs   = 10
	maxRedirectURILen = 2048
	maxClientNameLen  = 200
	maxRegisterBody   = 16 << 10
	clientIDBytes     = 24
)

// ClientRegistration is a Client plus the columns only registration cares
// about. It is a superset rather than a change to Client so that the grant and
// token handlers keep working against the smaller type they already use.
type ClientRegistration struct {
	Client
	ClientURI string
	// Source is SourceDCR or SourceCIMD, matching the CHECK constraint.
	Source   string
	IssuedAt time.Time
}

// ClientStore is TokenStore plus the writes registration needs.
//
// It is declared here, next to its only consumer, for the same reason
// TokenStore is declared next to the token endpoint: the interface a package
// depends on belongs to that package, and *PostgresStore satisfies all of them
// without knowing they exist.
type ClientStore interface {
	TokenStore

	// SaveClient inserts a client, or refreshes a CIMD client's cached
	// metadata. It must NOT let one registration source overwrite the other.
	SaveClient(ctx context.Context, reg ClientRegistration) error

	// TouchClient comes from TokenStore — the refresh grant needs it too, so it
	// is declared there rather than here.

	// DeleteUnusedClients removes clients idle since before the cutoff that
	// hold no live grant.
	DeleteUnusedClients(ctx context.Context, idleBefore time.Time) (int64, error)
}

// AuthorizationServerStore is everything the authorization server needs from
// Postgres: clients, codes and refresh tokens (ClientStore) plus consent
// tickets (ConsentStore).
//
// It exists so the wiring can hold ONE value and hand each handler the narrower
// interface it actually depends on. The narrow interfaces are the contract; this
// is only the union of them, and nothing takes it as a parameter.
type AuthorizationServerStore interface {
	ClientStore
	ConsentStore
}

// ---------------------------------------------------------------------------
// Client ID Metadata Documents
// ---------------------------------------------------------------------------

// MetadataFetcherConfig configures the CIMD fetch. Zero values take the
// Default* constants above.
type MetadataFetcherConfig struct {
	Timeout         time.Duration
	MaxBytes        int64
	SuccessTTL      time.Duration
	FailureTTL      time.Duration
	MaxCacheEntries int
	Now             func() time.Time

	// TEST-ONLY relaxations. They are unexported so no configuration file,
	// environment variable or caller outside this package can set them: the
	// only way to reach private address space or plain HTTP is to be a test in
	// package oauth.
	allowPrivateAddresses bool
	allowPlainHTTP        bool
}

type cacheEntry struct {
	reg     *ClientRegistration
	err     error
	expires time.Time
}

// MetadataFetcher fetches, validates and caches Client ID Metadata Documents.
type MetadataFetcher struct {
	client     *http.Client
	maxBytes   int64
	successTTL time.Duration
	failureTTL time.Duration
	maxEntries int
	now        func() time.Time

	allowPrivateAddresses bool
	allowPlainHTTP        bool

	mu    sync.Mutex
	cache map[string]cacheEntry
}

// errRedirectRefused is returned to http.Client's CheckRedirect.
//
// REDIRECTS ARE REFUSED OUTRIGHT, not re-checked per hop. Re-checking is
// possible but strictly weaker: the check would have to re-resolve the next
// hop's host, and between that resolution and the dial the DNS answer can
// change (rebinding). Refusing means the ONE address we validated in the dialer
// is the only address we ever connect to. A legitimate metadata document costs
// its publisher nothing to serve without a redirect.
var errRedirectRefused = errors.New("cimd: redirects are not followed")

// NewMetadataFetcher builds a fetcher whose HTTP client cannot reach private
// address space.
func NewMetadataFetcher(cfg MetadataFetcherConfig) *MetadataFetcher {
	timeout := cfg.Timeout
	if timeout <= 0 {
		timeout = DefaultCIMDTimeout
	}
	f := &MetadataFetcher{
		maxBytes:              orInt64(cfg.MaxBytes, DefaultCIMDMaxBytes),
		successTTL:            orDuration(cfg.SuccessTTL, DefaultCIMDSuccessTTL),
		failureTTL:            orDuration(cfg.FailureTTL, DefaultCIMDFailureTTL),
		maxEntries:            orInt(cfg.MaxCacheEntries, DefaultCIMDCacheEntries),
		now:                   cfg.Now,
		allowPrivateAddresses: cfg.allowPrivateAddresses,
		allowPlainHTTP:        cfg.allowPlainHTTP,
		cache:                 map[string]cacheEntry{},
	}
	if f.now == nil {
		f.now = time.Now
	}

	dialer := &net.Dialer{Timeout: timeout}
	if !cfg.allowPrivateAddresses {
		// Control runs AFTER DNS resolution, with the concrete address the
		// socket is about to connect to, and BEFORE the connect(2). That is the
		// only place a check is sound: `evil.example` may resolve to
		// 169.254.169.254, so inspecting the URL string proves nothing, and
		// resolving separately then dialing leaves a rebinding window between
		// the two.
		dialer.Control = func(network, address string, _ syscall.RawConn) error {
			switch network {
			case "tcp", "tcp4", "tcp6":
			default:
				return fmt.Errorf("cimd: refusing to dial network %q", network)
			}
			host, _, err := net.SplitHostPort(address)
			if err != nil {
				return fmt.Errorf("cimd: unparseable dial address %q", address)
			}
			ip := net.ParseIP(host)
			if ip == nil {
				return fmt.Errorf("cimd: unparseable dial address %q", address)
			}
			return checkPublicIP(ip)
		}
	}
	f.client = &http.Client{
		Timeout: timeout,
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
			return errRedirectRefused
		},
		Transport: &http.Transport{
			DialContext: dialer.DialContext,
			// No connection reuse: a pooled connection was validated against
			// the address policy at dial time, and reusing it for a later
			// request skips that check.
			DisableKeepAlives:     true,
			TLSHandshakeTimeout:   timeout,
			ResponseHeaderTimeout: timeout,
			ExpectContinueTimeout: time.Second,
			Proxy:                 nil, // never honour proxy env for this fetch
		},
	}
	return f
}

// isCIMDClientID reports whether a client_id is a Client ID Metadata Document
// URL rather than an opaque identifier. https ONLY: a http:// client_id would
// be a plaintext-fetched statement of who a client is.
func isCIMDClientID(clientID string) bool {
	return strings.HasPrefix(clientID, "https://")
}

// isCIMD is the fetcher's view of the same question. It differs from
// isCIMDClientID only under the test-only plain-HTTP relaxation, which no
// production configuration can set.
func (f *MetadataFetcher) isCIMD(clientID string) bool {
	if isCIMDClientID(clientID) {
		return true
	}
	return f.allowPlainHTTP && strings.HasPrefix(clientID, "http://")
}

// Resolve fetches and validates the metadata document for a CIMD client_id.
func (f *MetadataFetcher) Resolve(ctx context.Context, clientID string) (*ClientRegistration, error) {
	if entry, ok := f.lookup(clientID); ok {
		return entry.reg, entry.err
	}
	reg, err := f.fetch(ctx, clientID)
	f.store(clientID, reg, err)
	return reg, err
}

func (f *MetadataFetcher) lookup(clientID string) (cacheEntry, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	entry, ok := f.cache[clientID]
	if !ok || !f.now().Before(entry.expires) {
		return cacheEntry{}, false
	}
	return entry, true
}

func (f *MetadataFetcher) store(clientID string, reg *ClientRegistration, err error) {
	ttl := f.successTTL
	if err != nil {
		ttl = f.failureTTL
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.cache) >= f.maxEntries {
		now := f.now()
		for k, v := range f.cache {
			if !now.Before(v.expires) {
				delete(f.cache, k)
			}
		}
		// Still full of live entries: drop an arbitrary one rather than growing.
		// Map iteration order makes the victim unpredictable, which is fine —
		// the cost of a miss is one bounded fetch.
		for k := range f.cache {
			if len(f.cache) < f.maxEntries {
				break
			}
			delete(f.cache, k)
		}
	}
	f.cache[clientID] = cacheEntry{reg: reg, err: err, expires: f.now().Add(ttl)}
}

func (f *MetadataFetcher) fetch(ctx context.Context, clientID string) (*ClientRegistration, error) {
	u, err := f.validateClientIDURL(clientID)
	if err != nil {
		return nil, err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return nil, fmt.Errorf("cimd: building request: %w", err)
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "shorted-oauth/1.0 (+https://shorted.com.au)")

	resp, err := f.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("cimd: fetching %s: %w", redacted(u), err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("cimd: %s returned HTTP %d", redacted(u), resp.StatusCode)
	}

	// Read one byte past the cap so an oversized body is DETECTED rather than
	// silently truncated into a document that parses.
	body, err := io.ReadAll(io.LimitReader(resp.Body, f.maxBytes+1))
	if err != nil {
		return nil, fmt.Errorf("cimd: reading %s: %w", redacted(u), err)
	}
	if int64(len(body)) > f.maxBytes {
		return nil, fmt.Errorf("cimd: %s exceeded %d bytes", redacted(u), f.maxBytes)
	}

	var doc clientMetadataDocument
	if err := json.Unmarshal(body, &doc); err != nil {
		return nil, fmt.Errorf("cimd: %s is not a JSON metadata document: %w", redacted(u), err)
	}
	return doc.toRegistration(clientID)
}

// validateClientIDURL enforces the shape a CIMD client_id must have before a
// single packet is sent.
func (f *MetadataFetcher) validateClientIDURL(clientID string) (*url.URL, error) {
	u, err := url.Parse(clientID)
	if err != nil {
		return nil, fmt.Errorf("cimd: client_id is not a URL: %w", err)
	}
	switch u.Scheme {
	case "https":
	case "http":
		if !f.allowPlainHTTP {
			return nil, errors.New("cimd: client_id must use https")
		}
	default:
		return nil, fmt.Errorf("cimd: client_id scheme %q is not https", u.Scheme)
	}
	if u.Host == "" {
		return nil, errors.New("cimd: client_id has no host")
	}
	if u.User != nil {
		// Credentials in a client_id are both meaningless and a way to smuggle
		// an @ past a naive host check.
		return nil, errors.New("cimd: client_id must not contain userinfo")
	}
	if u.Fragment != "" || strings.Contains(clientID, "#") {
		// The fragment never reaches the server, so two different client_ids
		// would fetch one document — an identity collision.
		return nil, errors.New("cimd: client_id must not contain a fragment")
	}
	if !f.allowPrivateAddresses {
		// Fail fast on an address literal. The dialer would catch it anyway;
		// catching it here means no DNS lookup and no socket for the obvious
		// attempts.
		host := u.Hostname()
		if ip := net.ParseIP(host); ip != nil {
			if err := checkPublicIP(ip); err != nil {
				return nil, err
			}
		}
	}
	return u, nil
}

// clientMetadataDocument is the RFC 7591 client-metadata shape, which CIMD
// reuses verbatim.
type clientMetadataDocument struct {
	ClientID     string   `json:"client_id"`
	ClientName   string   `json:"client_name"`
	ClientURI    string   `json:"client_uri"`
	RedirectURIs []string `json:"redirect_uris"`
	GrantTypes   []string `json:"grant_types"`
	Scope        string   `json:"scope"`
}

func (d clientMetadataDocument) toRegistration(clientID string) (*ClientRegistration, error) {
	// SELF-REFERENCE IS THE WHOLE AUTHENTICATION MODEL OF CIMD. The document is
	// only allowed to describe the URL it was fetched from; without this check
	// any URL could publish a document claiming somebody else's client_id and
	// speak for a client it does not control.
	if d.ClientID != clientID {
		return nil, fmt.Errorf("cimd: document at %s declares client_id %q", clientID, d.ClientID)
	}
	redirects, err := validateRedirectURIs(d.RedirectURIs)
	if err != nil {
		return nil, fmt.Errorf("cimd: %w", err)
	}
	// Lenient on grant types, unlike DCR below: a document is something we
	// FOUND, not a request we can answer with an error message. Dropping an
	// unsupported grant type still yields a client that can only do what this
	// server supports.
	grants := normaliseGrantTypes(d.GrantTypes, false)
	name := truncate(d.ClientName, maxClientNameLen)
	return &ClientRegistration{
		Client: Client{
			ClientID:     clientID,
			ClientName:   name,
			RedirectURIs: redirects,
			GrantTypes:   grants,
			Scope:        filterScope(d.Scope),
		},
		ClientURI: truncate(d.ClientURI, maxRedirectURILen),
		Source:    SourceCIMD,
	}, nil
}

// ---------------------------------------------------------------------------
// The address policy
// ---------------------------------------------------------------------------

// checkPublicIP refuses every address range that is not a public internet
// destination.
//
// It is an ALLOWLIST by exclusion of the reserved space rather than a blocklist
// of "internal-looking" strings, because the interesting targets do not look
// interesting: 169.254.169.254 is the cloud metadata service, 100.64/10 is
// carrier NAT that reaches other tenants, ::ffff:10.0.0.1 is 10.0.0.1 wearing
// an IPv6 costume.
func checkPublicIP(ip net.IP) error {
	if ip == nil {
		return errors.New("cimd: no address")
	}
	// Unmap FIRST. An IPv4-mapped IPv6 address is an IPv4 address, and checking
	// it as IPv6 would miss every IPv4 rule below.
	if v4 := ip.To4(); v4 != nil {
		ip = v4
	}
	switch {
	case ip.IsUnspecified():
		return refuse(ip, "unspecified")
	case ip.IsLoopback():
		return refuse(ip, "loopback")
	case ip.IsLinkLocalUnicast(), ip.IsLinkLocalMulticast():
		// 169.254.0.0/16 — includes the cloud metadata service.
		return refuse(ip, "link-local")
	case ip.IsInterfaceLocalMulticast(), ip.IsMulticast():
		return refuse(ip, "multicast")
	case ip.IsPrivate():
		// 10/8, 172.16/12, 192.168/16, fc00::/7.
		return refuse(ip, "private")
	}
	if v4 := ip.To4(); v4 != nil {
		switch {
		case v4[0] == 100 && v4[1] >= 64 && v4[1] <= 127:
			return refuse(ip, "carrier-grade NAT (100.64.0.0/10)")
		case v4[0] == 192 && v4[1] == 0 && v4[2] == 0:
			return refuse(ip, "IETF protocol assignments (192.0.0.0/24)")
		case v4[0] == 198 && (v4[1] == 18 || v4[1] == 19):
			return refuse(ip, "benchmarking (198.18.0.0/15)")
		case v4[0] >= 240:
			// 240/4 reserved, and 255.255.255.255 broadcast.
			return refuse(ip, "reserved (240.0.0.0/4)")
		}
		return nil
	}
	// IPv6 transition mechanisms embed an IPv4 address; if the embedded address
	// is private, the tunnel is a bypass.
	if embedded := embeddedIPv4(ip); embedded != nil {
		if err := checkPublicIP(embedded); err != nil {
			return fmt.Errorf("cimd: refusing %s: it embeds a refused IPv4 address: %w", ip, err)
		}
	}
	return nil
}

func refuse(ip net.IP, why string) error {
	return fmt.Errorf("cimd: refusing to connect to %s (%s address space)", ip, why)
}

// embeddedIPv4 extracts the IPv4 address carried by 6to4 (2002::/16) and NAT64
// (64:ff9b::/96) addresses.
func embeddedIPv4(ip net.IP) net.IP {
	v6 := ip.To16()
	if v6 == nil {
		return nil
	}
	if v6[0] == 0x20 && v6[1] == 0x02 { // 2002::/16, 6to4
		return net.IPv4(v6[2], v6[3], v6[4], v6[5])
	}
	if v6[0] == 0x00 && v6[1] == 0x64 && v6[2] == 0xff && v6[3] == 0x9b { // 64:ff9b::/96
		return net.IPv4(v6[12], v6[13], v6[14], v6[15])
	}
	return nil
}

// redacted keeps a fetched URL's query out of the logs — it is attacker-chosen
// text and may carry anything.
func redacted(u *url.URL) string {
	return u.Scheme + "://" + u.Host + u.Path
}

// ---------------------------------------------------------------------------
// The resolving store
// ---------------------------------------------------------------------------

// ResolvingStore is a ClientStore that answers GetClient for CIMD client_ids by
// fetching the document, and for everything else from the database.
//
// It is a WRAPPER rather than a change to the grant and token handlers because
// those handlers should not know that two kinds of client_id exist: they ask
// "is this a registered client, and what are its redirect URIs", and the answer
// arrives the same way either way.
type ResolvingStore struct {
	ClientStore
	fetcher *MetadataFetcher
}

// NewResolvingStore returns nil when the inner store is nil, so a deployment
// with no database still reports temporarily_unavailable rather than panicking.
func NewResolvingStore(inner ClientStore, fetcher *MetadataFetcher) *ResolvingStore {
	if inner == nil {
		return nil
	}
	if fetcher == nil {
		fetcher = NewMetadataFetcher(MetadataFetcherConfig{})
	}
	return &ResolvingStore{ClientStore: inner, fetcher: fetcher}
}

// GetClient resolves a CIMD client_id by fetch, and any other by lookup.
//
// A CIMD client is PERSISTED as it is resolved. That is not caching — it is a
// referential-integrity requirement: oauth_authorization_codes.client_id and
// oauth_refresh_tokens.client_id are foreign keys into oauth_clients, so a code
// cannot be issued to a client that has no row.
//
// GetRegisteredClient is deliberately NOT overridden alongside it, and that
// asymmetry is the point rather than an omission: it stays promoted from the
// inner store, so it always answers from the persisted row. Overriding it "for
// consistency" would make the refresh grant depend on a third-party document
// being reachable, which is a mid-session logout waiting to happen — see the
// note on TokenStore.GetRegisteredClient.
func (s *ResolvingStore) GetClient(ctx context.Context, clientID string) (*Client, error) {
	if !s.fetcher.isCIMD(clientID) {
		client, err := s.ClientStore.GetClient(ctx, clientID)
		if err != nil || client == nil {
			return client, err
		}
		s.touch(ctx, clientID)
		return client, nil
	}

	reg, err := s.fetcher.Resolve(ctx, clientID)
	if err != nil {
		// An unfetchable or invalid document is an UNKNOWN CLIENT, not a server
		// error: the caller supplied a URL, and the URL did not describe a
		// client. Returning an error here would turn every hostile client_id
		// into a 500 on our side.
		log.Warnf("oauth: CIMD client_id %q did not resolve: %v", clientID, err)
		return nil, nil
	}
	if err := s.SaveClient(ctx, *reg); err != nil {
		// Fail CLOSED: without the row, the code insert would violate the
		// foreign key a moment later and surface as a 500 instead.
		return nil, fmt.Errorf("persisting CIMD client: %w", err)
	}
	s.touch(ctx, clientID)
	client := reg.Client
	return &client, nil
}

// touch is best effort. last_used_at only drives the unused-client sweep, and
// the sweep independently refuses to delete a client holding a live grant — so
// a failed touch costs freshness, never a cascade.
func (s *ResolvingStore) touch(ctx context.Context, clientID string) {
	if err := s.TouchClient(ctx, clientID); err != nil {
		log.Warnf("oauth: recording last_used_at for client %q failed: %v", clientID, err)
	}
}

// ---------------------------------------------------------------------------
// RFC 7591 dynamic client registration
// ---------------------------------------------------------------------------

// RegistrationConfig configures POST /oauth/register.
type RegistrationConfig struct {
	// Endpoints is carried for symmetry with the grant and token handlers and
	// for the registration_access_uri a future RFC 7592 management endpoint
	// would need. Registration itself issues no URLs, so nothing reads it yet.
	Endpoints Endpoints
	Store     ClientStore
	Now       func() time.Time
	// PerIPPerHour and PerIPPerDay default to the Default* constants.
	PerIPPerHour int
	PerIPPerDay  int
}

type registrationHandler struct {
	store   ClientStore
	now     func() time.Time
	limiter *registrationLimiter
}

// NewRegistrationHandler builds the POST /oauth/register handler.
//
// WHAT AUTHENTICATES A CALL HERE. Nothing — RFC 7591 open registration is
// unauthenticated by definition, and Claude and ChatGPT rely on that. What
// registering BUYS an attacker is therefore the question that matters, and the
// answer is deliberately as close to nothing as possible: a client row grants
// no access at all. It cannot be exchanged for a token without an authorization
// code, and a code is only issued after a human approves on the consent screen
// (Task 6's consent ticket) — so a registration on its own is a row, a rate
// limit consumed, and a sweep entry.
func NewRegistrationHandler(cfg RegistrationConfig) http.Handler {
	now := cfg.Now
	if now == nil {
		now = time.Now
	}
	return &registrationHandler{
		store: cfg.Store,
		now:   now,
		limiter: &registrationLimiter{
			perHour: orInt(cfg.PerIPPerHour, DefaultRegistrationsPerIPPerHour),
			perDay:  orInt(cfg.PerIPPerDay, DefaultRegistrationsPerIPPerDay),
			now:     now,
			seen:    map[string][]time.Time{},
		},
	}
}

type registrationRequest struct {
	ClientName   string   `json:"client_name"`
	ClientURI    string   `json:"client_uri"`
	RedirectURIs []string `json:"redirect_uris"`
	GrantTypes   []string `json:"grant_types"`
	// ResponseTypes is validated but not stored: "code" is the only response
	// type this AS supports, so anything else is a client that will not work.
	ResponseTypes           []string `json:"response_types"`
	Scope                   string   `json:"scope"`
	TokenEndpointAuthMethod string   `json:"token_endpoint_auth_method"`
}

func (h *registrationHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	// Browser-based MCP clients register cross-origin during discovery. This is
	// an unauthenticated, non-credentialed endpoint, so a wildcard grants
	// nothing a direct POST could not already do — and NO Allow-Credentials,
	// so no page can ride ambient authority here.
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST, OPTIONS")
		writeOAuthError(w, http.StatusMethodNotAllowed, "invalid_request", "POST required")
		return
	}
	if h.store == nil {
		writeOAuthError(w, http.StatusServiceUnavailable, "temporarily_unavailable",
			"the authorization server is not configured to register clients")
		return
	}

	// LIMIT FIRST, before parsing and before writing. Everything below costs
	// CPU or a row, and the caller is unauthenticated.
	ip := requestIP(r)
	if retryAfter, ok := h.limiter.allow(ip); !ok {
		w.Header().Set("Retry-After", strconv.Itoa(retryAfter))
		writeOAuthError(w, http.StatusTooManyRequests, "temporarily_unavailable",
			"too many client registrations from this address")
		return
	}

	var req registrationRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxRegisterBody)).Decode(&req); err != nil {
		writeOAuthError(w, http.StatusBadRequest, "invalid_client_metadata", "body must be JSON")
		return
	}

	redirects, err := validateRedirectURIs(req.RedirectURIs)
	if err != nil {
		writeOAuthError(w, http.StatusBadRequest, "invalid_redirect_uri", err.Error())
		return
	}
	// STRICT here, unlike CIMD: this is a request we can answer, and silently
	// dropping a grant type the client asked for produces a client that fails
	// later for no visible reason.
	grants, err := validateGrantTypes(req.GrantTypes)
	if err != nil {
		writeOAuthError(w, http.StatusBadRequest, "invalid_client_metadata", err.Error())
		return
	}
	for _, rt := range req.ResponseTypes {
		if rt != "code" {
			writeOAuthError(w, http.StatusBadRequest, "invalid_client_metadata",
				"response_types must be [\"code\"]")
			return
		}
	}
	// Public clients only. token_endpoint_auth_methods_supported is ["none"],
	// so a client asking for a secret is asking for something that would not be
	// checked — say so rather than issuing one it cannot use.
	if m := req.TokenEndpointAuthMethod; m != "" && m != "none" {
		writeOAuthError(w, http.StatusBadRequest, "invalid_client_metadata",
			"token_endpoint_auth_method must be \"none\"; every client here is public")
		return
	}

	clientID, err := newClientID()
	if err != nil {
		log.Errorf("oauth register: generating client_id: %v", err)
		writeOAuthError(w, http.StatusInternalServerError, "server_error", "could not register the client")
		return
	}

	reg := ClientRegistration{
		Client: Client{
			ClientID:     clientID,
			ClientName:   truncate(req.ClientName, maxClientNameLen),
			RedirectURIs: redirects,
			GrantTypes:   grants,
			Scope:        filterScope(req.Scope),
		},
		ClientURI: truncate(req.ClientURI, maxRedirectURILen),
		Source:    SourceDCR,
		IssuedAt:  h.now(),
	}
	if err := h.store.SaveClient(r.Context(), reg); err != nil {
		log.Errorf("oauth register: storing client: %v", err)
		writeOAuthError(w, http.StatusInternalServerError, "server_error", "could not register the client")
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"client_id":           reg.ClientID,
		"client_id_issued_at": reg.IssuedAt.Unix(),
		"client_name":         reg.ClientName,
		"client_uri":          reg.ClientURI,
		"redirect_uris":       reg.RedirectURIs,
		"grant_types":         reg.GrantTypes,
		"response_types":      []string{"code"},
		// No client_secret, and that is a statement: this AS has no
		// confidential clients, so there is nothing to leak and nothing to
		// rotate. PKCE is what stands in for client authentication.
		"token_endpoint_auth_method": "none",
		"scope":                      reg.Scope,
	})
}

// ---------------------------------------------------------------------------
// Registration abuse limits
// ---------------------------------------------------------------------------

// registrationLimiter is a two-window sliding counter per IP, in memory.
//
// In memory, per instance, exactly like pkg/ratelimit's per-minute limiter and
// for the same reasons: there is no IP column in migration 000116, and adding a
// shared counter store would reintroduce the dependency the August 2026
// incident removed. The consequence — N instances means up to N times the
// limit — is acceptable for abuse shaping.
type registrationLimiter struct {
	perHour int
	perDay  int
	now     func() time.Time

	mu   sync.Mutex
	seen map[string][]time.Time
}

// allow records an ATTEMPT and reports whether it may proceed, plus a
// Retry-After in seconds.
func (l *registrationLimiter) allow(ip string) (int, bool) {
	now := l.now()
	l.mu.Lock()
	defer l.mu.Unlock()

	if len(l.seen) >= maxRegistrationIPs {
		l.pruneLocked(now)
	}
	if _, known := l.seen[ip]; !known && len(l.seen) >= maxRegistrationIPs {
		// FAIL CLOSED, deliberately — the opposite of the quota limiter's
		// fail-open rule, and for a different job. Failing open there protects
		// a reader from a sick database; failing open here would hand an
		// attacker who filled the table an unlimited write endpoint. Refusing
		// costs a new client one retry.
		log.Warnf("oauth register: per-IP table full; refusing new registrations")
		return 60, false
	}

	stamps := prune(l.seen[ip], now.Add(-24*time.Hour))
	hourAgo := now.Add(-time.Hour)
	inHour := 0
	for _, t := range stamps {
		if t.After(hourAgo) {
			inHour++
		}
	}
	// The attempt counts whether or not it is allowed.
	l.seen[ip] = append(stamps, now)

	if inHour >= l.perHour {
		return retryAfterSeconds(stamps, now, time.Hour), false
	}
	if len(stamps) >= l.perDay {
		return retryAfterSeconds(stamps, now, 24*time.Hour), false
	}
	return 0, true
}

func (l *registrationLimiter) pruneLocked(now time.Time) {
	cutoff := now.Add(-24 * time.Hour)
	for ip, stamps := range l.seen {
		kept := prune(stamps, cutoff)
		if len(kept) == 0 {
			delete(l.seen, ip)
			continue
		}
		l.seen[ip] = kept
	}
}

func prune(stamps []time.Time, cutoff time.Time) []time.Time {
	kept := stamps[:0]
	for _, t := range stamps {
		if t.After(cutoff) {
			kept = append(kept, t)
		}
	}
	return kept
}

// retryAfterSeconds is how long until the oldest counted attempt falls out of
// the window. Never zero: a Retry-After of 0 invites an immediate retry.
func retryAfterSeconds(stamps []time.Time, now time.Time, window time.Duration) int {
	if len(stamps) == 0 {
		return int(window / time.Second)
	}
	oldest := stamps[0]
	for _, t := range stamps {
		if t.Before(oldest) {
			oldest = t
		}
	}
	secs := int(oldest.Add(window).Sub(now).Seconds())
	if secs < 1 {
		return 1
	}
	return secs
}

// requestIP is the plain-HTTP twin of pkg/ratelimit's extractIP, and follows
// the same rule: take the RIGHTMOST X-Forwarded-For entry, because a client can
// prepend anything it likes to the left and only the trusted proxy appends on
// the right.
func requestIP(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		parts := strings.Split(xff, ",")
		for i := len(parts) - 1; i >= 0; i-- {
			if ip := strings.TrimSpace(parts[i]); ip != "" {
				return ip
			}
		}
	}
	if v := r.Header.Get("CF-Connecting-IP"); v != "" {
		return strings.TrimSpace(v)
	}
	if v := r.Header.Get("X-Real-IP"); v != "" {
		return strings.TrimSpace(v)
	}
	if host, _, err := net.SplitHostPort(r.RemoteAddr); err == nil {
		return host
	}
	if r.RemoteAddr != "" {
		return r.RemoteAddr
	}
	return "unknown"
}

// ---------------------------------------------------------------------------
// Metadata validation shared by both registration paths
// ---------------------------------------------------------------------------

// validateRedirectURIs is where an open redirect would be born, so it is
// strict. The grant handler compares by exact string equality, which means
// whatever is accepted HERE is exactly what a code can be delivered to.
func validateRedirectURIs(uris []string) ([]string, error) {
	if len(uris) == 0 {
		return nil, errors.New("redirect_uris is required and must not be empty")
	}
	if len(uris) > maxRedirectURIs {
		return nil, fmt.Errorf("at most %d redirect_uris are accepted", maxRedirectURIs)
	}
	out := make([]string, 0, len(uris))
	seen := map[string]bool{}
	for _, raw := range uris {
		if err := validateRedirectURI(raw); err != nil {
			return nil, err
		}
		if seen[raw] {
			continue
		}
		seen[raw] = true
		out = append(out, raw)
	}
	return out, nil
}

func validateRedirectURI(raw string) error {
	if raw == "" {
		return errors.New("a redirect_uri must not be empty")
	}
	if len(raw) > maxRedirectURILen {
		return fmt.Errorf("a redirect_uri may not exceed %d characters", maxRedirectURILen)
	}
	if strings.ContainsAny(raw, " \t\r\n") {
		return errors.New("a redirect_uri must not contain whitespace")
	}
	if strings.Contains(raw, "*") {
		// A wildcard is an open redirect with extra steps.
		return errors.New("a redirect_uri must not contain a wildcard")
	}
	u, err := url.Parse(raw)
	if err != nil {
		return fmt.Errorf("redirect_uri %q is not a URI", raw)
	}
	if u.Scheme == "" || !u.IsAbs() {
		return fmt.Errorf("redirect_uri %q must be absolute", raw)
	}
	if u.Fragment != "" || strings.Contains(raw, "#") {
		// RFC 6749 §3.1.2: the redirection endpoint URI MUST NOT include a
		// fragment. It would also collide with the fragment a response uses.
		return fmt.Errorf("redirect_uri %q must not contain a fragment", raw)
	}
	switch strings.ToLower(u.Scheme) {
	case "https":
		if u.Hostname() == "" {
			return fmt.Errorf("redirect_uri %q has no host", raw)
		}
		return nil
	case "http":
		// RFC 8252 §7.3: plain http is acceptable ONLY on loopback, where there
		// is no network to intercept. Anywhere else it would deliver an
		// authorization code in the clear.
		if isLoopbackHost(u.Hostname()) {
			return nil
		}
		return fmt.Errorf("redirect_uri %q uses http on a non-loopback host", raw)
	case "javascript", "data", "vbscript", "file", "blob":
		// Named explicitly so the refusal is legible in a log, even though the
		// default branch would catch them.
		return fmt.Errorf("redirect_uri scheme %q is not allowed", u.Scheme)
	default:
		// RFC 8252 §7.1 private-use scheme: a native app registers a scheme it
		// controls, which by convention is a reversed DNS name. Requiring the
		// dot keeps single-word schemes (and the dangerous ones above) out.
		if strings.Contains(u.Scheme, ".") {
			return nil
		}
		return fmt.Errorf("redirect_uri scheme %q is not allowed", u.Scheme)
	}
}

func isLoopbackHost(host string) bool {
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// supportedGrantTypes is what this AS actually implements. The password and
// implicit grants are absent because OAuth 2.1 removes them.
var supportedGrantTypes = map[string]bool{
	"authorization_code": true,
	"refresh_token":      true,
}

// validateGrantTypes is the strict form used by DCR.
func validateGrantTypes(requested []string) ([]string, error) {
	for _, g := range requested {
		if !supportedGrantTypes[g] {
			return nil, fmt.Errorf("grant_type %q is not supported", g)
		}
	}
	return normaliseGrantTypes(requested, true), nil
}

// normaliseGrantTypes applies the RFC 7591 §2 default and this server's
// implication rules.
//
// THIS IS WHY THE COLUMN IS NEVER '{}'. Migration 000116 defaults grant_types
// to '{}', which makes "the client omitted grant_types" and "the client
// explicitly asked for none" the same stored value — and RFC 7591 says the
// first of those means ["authorization_code"]. Applying the default at
// registration collapses the ambiguity before it is written, so a reader can
// treat an empty grant_types as impossible rather than as "unknown, allow it".
func normaliseGrantTypes(requested []string, strict bool) []string {
	set := map[string]bool{}
	for _, g := range requested {
		if supportedGrantTypes[g] {
			set[g] = true
		} else if strict {
			// validateGrantTypes has already refused; unreachable.
			continue
		}
	}
	// refresh_token is not a standalone grant: RFC 7591 §2 notes it is used
	// alongside the grant that issued the refresh token, and here that is
	// always authorization_code.
	if set["refresh_token"] {
		set["authorization_code"] = true
	}
	if len(set) == 0 {
		set["authorization_code"] = true
	}
	out := make([]string, 0, len(set))
	for g := range set {
		out = append(out, g)
	}
	sort.Strings(out) // deterministic storage, so a diff of two rows is legible
	return out
}

// filterScope keeps only scopes this resource server publishes.
//
// FILTERING, NOT REFUSING, and the difference matters for compatibility: real
// clients send scopes belonging to other servers ("openid", "profile", vendor
// strings) in a registration. Refusing the registration would break them for a
// value that grants nothing. What is stored is the intersection, and the grant
// handler then holds the client to it.
//
// An empty result is stored empty, which the grant handler reads as "no
// declared subset" and answers with the published read vocabulary — the same
// treatment as a client that sent no scope at all. That is not a widening:
// every published scope is read-only against the single MCP resource.
func filterScope(scope string) string {
	published := map[string]bool{}
	for _, s := range mcp.Scopes {
		published[s] = true
	}
	kept := make([]string, 0, len(mcp.Scopes))
	seen := map[string]bool{}
	for _, s := range strings.Fields(scope) {
		if published[s] && !seen[s] {
			seen[s] = true
			kept = append(kept, s)
		}
	}
	return strings.Join(kept, " ")
}

func newClientID() (string, error) {
	buf := make([]byte, clientIDBytes)
	if _, err := rand.Read(buf); err != nil {
		return "", fmt.Errorf("reading entropy: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}

// ---------------------------------------------------------------------------
// Expiring unused clients
// ---------------------------------------------------------------------------

// SweepUnusedClients deletes clients idle for longer than UnusedClientTTL.
//
// An open registration endpoint accumulates junk, and junk that is never
// deleted is a table that only grows. The danger is the other direction: the
// foreign keys from oauth_authorization_codes and oauth_refresh_tokens are ON
// DELETE CASCADE, so deleting a client silently signs out anyone still using
// it. Two independent guards keep that from happening — last_used_at (touched
// on every client lookup, see ResolvingStore.touch) and the store's own NOT
// EXISTS checks against live tokens and unexpired codes.
func SweepUnusedClients(ctx context.Context, store ClientStore, now time.Time) (int64, error) {
	if store == nil {
		return 0, nil
	}
	return store.DeleteUnusedClients(ctx, now.Add(-UnusedClientTTL))
}

// StartClientSweeper runs SweepUnusedClients on a ticker until ctx is done.
func StartClientSweeper(ctx context.Context, store ClientStore, interval time.Duration) {
	if store == nil {
		return
	}
	if interval <= 0 {
		interval = 24 * time.Hour
	}
	go func() {
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				n, err := SweepUnusedClients(ctx, store, time.Now())
				if err != nil {
					log.Errorf("oauth: sweeping unused clients: %v", err)
					continue
				}
				if n > 0 {
					log.Infof("oauth: swept %d unused clients", n)
				}
			}
		}
	}()
}

// ---------------------------------------------------------------------------

func truncate(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return s[:max]
}

func orInt(v, fallback int) int {
	if v <= 0 {
		return fallback
	}
	return v
}

func orInt64(v, fallback int64) int64 {
	if v <= 0 {
		return fallback
	}
	return v
}

func orDuration(v, fallback time.Duration) time.Duration {
	if v <= 0 {
		return fallback
	}
	return v
}
