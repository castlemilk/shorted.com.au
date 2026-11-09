package main

import (
	"bytes"
	"errors"
	"go/ast"
	"go/parser"
	"go/token"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type revalidateRoundTripFunc func(*http.Request) (*http.Response, error)

func (f revalidateRoundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func useRevalidateTransport(t *testing.T, fn revalidateRoundTripFunc) {
	t.Helper()
	previous := http.DefaultClient.Transport
	http.DefaultClient.Transport = fn
	t.Cleanup(func() { http.DefaultClient.Transport = previous })
}

func revalidateResponse(status int, body string) *http.Response {
	return &http.Response{StatusCode: status, Body: io.NopCloser(strings.NewReader(body)), Header: make(http.Header)}
}

// TestPingRevalidateSendsExpectedQuery asserts the official refresh's cache bust
// carries the secret in a header (never the logged URL), the crawl's paths and
// flush, and the housing tag.
func TestPingRevalidateSendsExpectedQuery(t *testing.T) {
	var got *http.Request
	useRevalidateTransport(t, func(r *http.Request) (*http.Response, error) {
		got = r
		return revalidateResponse(http.StatusOK, `{"revalidated":true}`), nil
	})

	t.Setenv("REVALIDATION_URL", "https://revalidate.invalid/api/revalidate")
	t.Setenv("REVALIDATION_SECRET", "s3cr3t")

	pingRevalidate("test")

	if got == nil {
		t.Fatal("expected a revalidation request, got none")
	}

	if got.Method != http.MethodPost {
		t.Errorf("method = %s, want POST", got.Method)
	}
	q := got.URL.Query()
	if got.Header.Get("X-Revalidate-Secret") != "s3cr3t" {
		t.Errorf("X-Revalidate-Secret = %q, want s3cr3t", got.Header.Get("X-Revalidate-Secret"))
	}
	if _, ok := q["secret"]; ok {
		t.Errorf("secret must not ride in query string, got %q", q.Get("secret"))
	}
	if q.Get("path") != "/price-drops,/housing" {
		t.Errorf("path = %q, want /price-drops,/housing", q.Get("path"))
	}
	if q.Get("flush") != "housing" {
		t.Errorf("flush = %q, want housing", q.Get("flush"))
	}
	// The tag is what busts the suburb profile's state index in Next's data
	// cache; path+flush do not reach it.
	if q.Get("tag") != "housing" {
		t.Errorf("tag = %q, want housing", q.Get("tag"))
	}
}

// captureRevalidate runs ping against a recording transport and returns the one
// request it sent.
func captureRevalidate(t *testing.T, ping func()) *http.Request {
	t.Helper()
	var got []*http.Request
	useRevalidateTransport(t, func(r *http.Request) (*http.Response, error) {
		got = append(got, r)
		return revalidateResponse(http.StatusOK, `{"revalidated":true}`), nil
	})
	t.Setenv("REVALIDATION_URL", "https://revalidate.invalid/api/revalidate")
	t.Setenv("REVALIDATION_SECRET", "s3cr3t")
	ping()
	if len(got) != 1 {
		t.Fatalf("sent %d revalidation request(s), want 1", len(got))
	}
	return got[0]
}

// assertCrawlScope checks a crawl write's cache bust: the two routes and the
// housing KV family, the secret in a header, and NO tag. The `housing` tag
// expires every state and suburb page. Before this scope was split out, the
// 30-minute crawl-finalize sent it about 20 times a day.
func assertCrawlScope(t *testing.T, r *http.Request) {
	t.Helper()
	q := r.URL.Query()
	if r.Method != http.MethodPost {
		t.Errorf("method = %s, want POST", r.Method)
	}
	if r.Header.Get("X-Revalidate-Secret") != "s3cr3t" {
		t.Errorf("X-Revalidate-Secret = %q, want s3cr3t", r.Header.Get("X-Revalidate-Secret"))
	}
	if _, ok := q["secret"]; ok {
		t.Errorf("secret must not ride in query string, got %q", q.Get("secret"))
	}
	if q.Get("path") != "/price-drops,/housing" {
		t.Errorf("path = %q, want /price-drops,/housing", q.Get("path"))
	}
	if q.Get("flush") != "housing" {
		t.Errorf("flush = %q, want housing", q.Get("flush"))
	}
	if tags, ok := q["tag"]; ok {
		t.Errorf("a crawl write's cache bust sent tag=%q; it must send no tag", tags)
	}
}

func TestPingCrawlRevalidateSendsNoTag(t *testing.T) {
	assertCrawlScope(t, captureRevalidate(t, func() { pingCrawlRevalidate("test") }))
}

// crawl-finalize is what runs every 30 minutes, so its production wiring is the
// one that matters most. A refactor that hands it pingRevalidate again would
// pass every finalize ordering test.
func TestCrawlFinalizeSendsTheCrawlScope(t *testing.T) {
	ops := productionFinalizeOps(nil)
	assertCrawlScope(t, captureRevalidate(t, func() { ops.revalidate("crawl-finalize") }))
}

// The housing tag is sent from exactly one place: refresh(), the official data
// refresh. Every other path in this package that writes housing data is a crawl
// write and must use pingCrawlRevalidate. A function value passed rather than
// called (finalizeOps.revalidate) is a reference too, so both are counted.
func TestOnlyRefreshSendsTheHousingTag(t *testing.T) {
	names, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatal(err)
	}
	fset := token.NewFileSet()
	var refs []string
	for _, name := range names {
		if strings.HasSuffix(name, "_test.go") {
			continue
		}
		file, err := parser.ParseFile(fset, name, nil, 0)
		if err != nil {
			t.Fatal(err)
		}
		for _, decl := range file.Decls {
			fn, ok := decl.(*ast.FuncDecl)
			if !ok || fn.Body == nil || fn.Name.Name == "pingRevalidate" {
				continue
			}
			ast.Inspect(fn.Body, func(n ast.Node) bool {
				if id, ok := n.(*ast.Ident); ok && id.Name == "pingRevalidate" {
					refs = append(refs, fn.Name.Name+" ("+fset.Position(id.Pos()).String()+")")
				}
				return true
			})
		}
	}
	if len(refs) != 1 || !strings.HasPrefix(refs[0], "refresh ") {
		t.Fatalf("pingRevalidate (the housing tag) is referenced from %v; want refresh() alone. "+
			"A crawl write uses pingCrawlRevalidate.", refs)
	}
}

// TestPingRevalidateSkipsWhenUnset asserts the ping is a no-op (no HTTP request)
// when either env var is empty — so an unconfigured collector never errors.
func TestPingRevalidateSkipsWhenUnset(t *testing.T) {
	hits := 0
	useRevalidateTransport(t, func(r *http.Request) (*http.Response, error) {
		hits++
		return revalidateResponse(http.StatusOK, ""), nil
	})

	cases := []struct {
		name   string
		url    string
		secret string
	}{
		{"both empty", "", ""},
		{"url set, secret empty", "https://revalidate.invalid", ""},
		{"secret set, url empty", "", "s3cr3t"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("REVALIDATION_URL", tc.url)
			t.Setenv("REVALIDATION_SECRET", tc.secret)

			pingRevalidate("test")
			pingCrawlRevalidate("test")
		})
	}
	if hits != 0 {
		t.Fatalf("no HTTP request should be sent when a revalidation env var is unset, got %d", hits)
	}
}

// TestPingRevalidateToleratesNon2xx asserts a non-2xx response is logged as a
// warning but never panics or blocks — the run continues unaffected.
func TestPingRevalidateToleratesNon2xx(t *testing.T) {
	useRevalidateTransport(t, func(r *http.Request) (*http.Response, error) {
		return revalidateResponse(http.StatusInternalServerError, "upstream boom"), nil
	})

	t.Setenv("REVALIDATION_URL", "https://revalidate.invalid")
	t.Setenv("REVALIDATION_SECRET", "s3cr3t")

	// Must return normally despite the 5xx (no panic, no error propagation).
	pingRevalidate("test")
}

// A round run by the drain wrapper must not ping: one ping purges /price-drops,
// /housing and every suburb page, and a drain runs many rounds. It logs the
// marker instead and the drain pings once. Outside the drain (the single-round
// run-housing-agent.sh, a hand run) the round still pings itself.
func TestRevalidateAfterCrawlWriteDefersToTheDrain(t *testing.T) {
	hits := 0
	var last *http.Request
	useRevalidateTransport(t, func(r *http.Request) (*http.Response, error) {
		hits++
		last = r
		return revalidateResponse(http.StatusOK, `{"revalidated":true}`), nil
	})
	t.Setenv("REVALIDATION_URL", "https://revalidate.invalid/api/revalidate")
	t.Setenv("REVALIDATION_SECRET", "s3cr3t")
	var logs bytes.Buffer
	previous := log.Writer()
	log.SetOutput(&logs)
	t.Cleanup(func() { log.SetOutput(previous) })

	t.Setenv(revalidateDeferEnv, "1")
	revalidateAfterCrawlWrite("agent")
	if hits != 0 {
		t.Fatalf("a deferred round sent %d revalidation request(s), want 0", hits)
	}
	if !strings.Contains(logs.String(), "[revalidate:agent] "+revalidateDeferredMarker) {
		t.Errorf("a deferred round must log the drain's marker, got: %q", logs.String())
	}

	t.Setenv(revalidateDeferEnv, "")
	revalidateAfterCrawlWrite("agent")
	if hits != 1 {
		t.Fatalf("a round outside the drain sent %d revalidation request(s), want 1", hits)
	}
	assertCrawlScope(t, last)
}

// The drain finds a round's deferred ping only by grepping its output, sets the
// deferral env itself, and names the mode that sends the one ping. Pin all three
// in the wrapper's code, so renaming any of them here (or there) fails a test
// instead of silently dropping the ping. Comment lines are dropped first: the
// wrapper's header comment names all three, so a match over the whole file
// stayed green with the code that uses them gone.
func TestDrainWrapperMatchesTheDeferralContract(t *testing.T) {
	src, err := os.ReadFile("deploy/housing-crawl-common.sh")
	if err != nil {
		t.Fatal(err)
	}
	var code strings.Builder
	for line := range strings.SplitSeq(string(src), "\n") {
		if !strings.HasPrefix(strings.TrimSpace(line), "#") {
			code.WriteString(line + "\n")
		}
	}
	// The trailing spaces end each mode name: "-mode revalidate-all" is no match.
	for _, want := range []string{
		revalidateDeferEnv + `=1 "$BIN" -mode agent `, // each round defers its ping
		`grep -q "` + revalidateDeferredMarker + `"`,  // the drain sees that one did
		`"$BIN" -mode ` + revalidateMode + ` `,        // and sends the one ping
	} {
		if !strings.Contains(code.String(), want) {
			t.Errorf("deploy/housing-crawl-common.sh has no code line containing %q", want)
		}
	}
}

// A raw *url.Error stringifies the full request URL. That is how an endpoint —
// and anything its query carries — ends up in a Cloud Run log line, so the
// redaction is worth pinning rather than trusting to review.
func TestRedactURLErrorStripsTheEndpoint(t *testing.T) {
	inner := errors.New("dial tcp 10.0.0.1:443: connect: connection refused")
	err := redactURLError(&url.Error{
		Op:  "Post",
		URL: "https://shorted.com.au/api/revalidate?secret=super-secret&path=/housing",
		Err: inner,
	})

	got := err.Error()
	for _, leaked := range []string{"super-secret", "shorted.com.au", "/api/revalidate", "path=/housing"} {
		if strings.Contains(got, leaked) {
			t.Errorf("redacted error still contains %q: %s", leaked, got)
		}
	}
	if !strings.Contains(got, "Post") || !strings.Contains(got, "[url redacted]") {
		t.Errorf("want the operation and a redaction marker, got: %s", got)
	}
	// The cause must survive — redaction that hides the reason is worse than the leak.
	if !errors.Is(err, inner) {
		t.Errorf("redaction dropped the wrapped cause: %v", err)
	}
}

// A non-URL error must pass through untouched, or every unrelated failure in
// this path becomes harder to read for no benefit.
func TestRedactURLErrorPassesThroughOtherErrors(t *testing.T) {
	plain := errors.New("context deadline exceeded")
	if got := redactURLError(plain); got != plain {
		t.Errorf("non-url error was rewritten: %v", got)
	}
}
