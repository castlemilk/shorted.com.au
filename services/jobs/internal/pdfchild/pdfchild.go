// Package pdfchild reads PDFs in child processes of this binary.
//
// The readers are pure Go (the image is distroless) and cannot bound what one
// document costs: a malformed content stream or a decompression bomb runs
// until the container's memory limit kills the whole job. shorted-announcements
// died that way every night from 2026-10-15, so every notice it had not yet
// read waited behind the one that killed it. In a child, a document costs only
// itself: the parent streams the PDF to the child's stdin and never holds the
// bytes, watches the child's resident set and kills it past an allowance, and a
// deadline bounds a reader that loops.
//
// A child is this same binary started with EnvMode naming a mode. main (and a
// test binary's TestMain) calls Serve before anything else; Serve runs the
// mode's Extract on stdin and the process exits.
package pdfchild

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
	"time"

	"golang.org/x/sync/semaphore"
)

const (
	// EnvMode names the mode a child runs; set only on a child.
	EnvMode     = "SHORTED_PDF_CHILD"
	envMaxPages = "SHORTED_PDF_MAX_PAGES"

	// MaxPDFBytes bounds one document. ASX announcement PDFs are single-digit
	// MB; 64 MiB is far above any real filing.
	MaxPDFBytes = 64 << 20

	baseAllowance = 64 << 20
	perByte       = 40
	minAllowance  = 256 << 20
	maxAllowance  = 1536 << 20
	addressLimit  = 4 << 30
	childTimeout  = 60 * time.Second
	maxOutput     = 4 << 20
)

// Extract renders the first maxPages pages of a PDF as text.
type Extract func(data []byte, maxPages int) (string, error)

// Serve runs this process as a PDF child when EnvMode names one of modes, and
// reports whether it did and the exit code to leave with.
func Serve(modes map[string]Extract) (handled bool, exitCode int) {
	name := os.Getenv(EnvMode)
	if name == "" {
		return false, 0
	}
	extract, ok := modes[name]
	if !ok {
		fmt.Fprintf(os.Stderr, "pdf child: unknown mode %q\n", name)
		return true, 2
	}
	maxPages, _ := strconv.Atoi(os.Getenv(envMaxPages))
	if err := serve(os.Stdin, os.Stdout, extract, maxPages); err != nil {
		fmt.Fprintf(os.Stderr, "pdf child: %v\n", err)
		return true, 1
	}
	return true, 0
}

func serve(stdin io.Reader, stdout io.Writer, extract Extract, maxPages int) error {
	// The backstop for a parent that cannot watch /proc. macOS refuses
	// RLIMIT_AS; there the deadline is the bound.
	if err := syscall.Setrlimit(syscall.RLIMIT_AS, &syscall.Rlimit{Cur: addressLimit, Max: addressLimit}); err != nil {
		fmt.Fprintf(os.Stderr, "pdf child: address-space limit not set: %v\n", err)
	}
	data, err := io.ReadAll(io.LimitReader(stdin, MaxPDFBytes))
	if err != nil {
		return err
	}
	text, err := extract(data, maxPages)
	if err != nil {
		return err
	}
	_, err = io.WriteString(stdout, text)
	return err
}

// Allowance is the resident memory a child may use for a PDF of n bytes. An
// unknown size (n < 0, a response with no Content-Length) gets the most.
func Allowance(n int64) int64 {
	if n < 0 {
		return maxAllowance
	}
	return min(max(baseAllowance+n*perByte, minAllowance), maxAllowance)
}

// Reader reads PDFs in children of one mode that share a resident-memory
// budget: a child waits until its allowance fits. Safe for concurrent use.
type Reader struct {
	mode    string
	budget  *semaphore.Weighted
	total   int64
	timeout time.Duration
}

// NewReader returns a Reader whose children share budgetBytes of resident
// memory (at least one smallest allowance).
func NewReader(mode string, budgetBytes int64) *Reader {
	budgetBytes = max(budgetBytes, minAllowance)
	return &Reader{mode: mode, budget: semaphore.NewWeighted(budgetBytes), total: budgetBytes, timeout: childTimeout}
}

// Read streams a PDF of size bytes (-1 when unknown) from pdf into a child and
// returns the text of its first maxPages pages.
func (r *Reader) Read(ctx context.Context, pdf io.Reader, size int64, maxPages int) (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", fmt.Errorf("locate own executable: %w", err)
	}
	allowance := min(Allowance(size), r.total)
	if err := r.budget.Acquire(ctx, allowance); err != nil {
		return "", err
	}
	defer r.budget.Release(allowance)
	ctx, cancel := context.WithTimeout(ctx, r.timeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, exe)
	cmd.Stdin = io.LimitReader(pdf, MaxPDFBytes)
	// A child that dies mid-document leaves the stdin copy reading a slow
	// download; WaitDelay stops Wait from waiting on it.
	cmd.WaitDelay = 5 * time.Second
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &limitedBuffer{buf: &stdout, max: maxOutput}
	cmd.Stderr = &limitedBuffer{buf: &stderr, max: 8 << 10}
	// The child inherits nothing it could write with. Its own GC works to stay
	// under three quarters of the allowance before the watcher steps in.
	cmd.Env = []string{
		EnvMode + "=" + r.mode,
		envMaxPages + "=" + strconv.Itoa(maxPages),
		"GOMEMLIMIT=" + strconv.FormatInt(allowance/4*3, 10),
	}
	if err := cmd.Start(); err != nil {
		return "", fmt.Errorf("start pdf child: %w", err)
	}
	done := make(chan struct{})
	overLimit := make(chan int64, 1)
	go watchRSS(cmd.Process, allowance, done, overLimit)
	err = cmd.Wait()
	close(done)
	select {
	case rss := <-overLimit:
		return "", fmt.Errorf("pdf child killed at %d MB resident (allowance %d MB)", rss>>20, allowance>>20)
	default:
	}
	if ctx.Err() != nil && !errors.Is(ctx.Err(), context.Canceled) {
		return "", fmt.Errorf("pdf child stopped after %s", r.timeout)
	}
	if err != nil {
		tail := strings.TrimSpace(stderr.String())
		if i := strings.LastIndex(tail, "\n"); i >= 0 && len(tail)-i < 300 {
			tail = tail[i+1:]
		}
		if len(tail) > 300 {
			tail = tail[:300]
		}
		return "", fmt.Errorf("pdf child: %w (%s)", err, tail)
	}
	return stdout.String(), nil
}

// watchRSS kills the child when /proc says its resident set passed limit.
// Without /proc (macOS) it returns at once and the deadline is the bound.
func watchRSS(p *os.Process, limit int64, done <-chan struct{}, overLimit chan<- int64) {
	path := "/proc/" + strconv.Itoa(p.Pid) + "/status"
	tick := time.NewTicker(25 * time.Millisecond)
	defer tick.Stop()
	for {
		select {
		case <-done:
			return
		case <-tick.C:
		}
		rss, ok := residentBytes(path)
		if !ok {
			return
		}
		if rss > limit {
			overLimit <- rss
			_ = p.Kill()
			return
		}
	}
}

// residentBytes reads VmRSS from a /proc/<pid>/status file.
func residentBytes(path string) (int64, bool) {
	b, err := os.ReadFile(path)
	if err != nil {
		return 0, false
	}
	for line := range strings.SplitSeq(string(b), "\n") {
		if rest, ok := strings.CutPrefix(line, "VmRSS:"); ok {
			f := strings.Fields(rest)
			if len(f) == 0 {
				return 0, false
			}
			kb, err := strconv.ParseInt(f[0], 10, 64)
			if err != nil {
				return 0, false
			}
			return kb << 10, true
		}
	}
	return 0, false
}

// limitedBuffer stops collecting past max bytes but never fails the write, so
// a chatty child cannot grow the parent.
type limitedBuffer struct {
	buf *bytes.Buffer
	max int
}

func (l *limitedBuffer) Write(p []byte) (int, error) {
	if room := l.max - l.buf.Len(); room > 0 {
		if len(p) > room {
			l.buf.Write(p[:room])
		} else {
			l.buf.Write(p)
		}
	}
	return len(p), nil
}
