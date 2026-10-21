package pdfchild

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"strconv"
	"strings"
	"testing"
	"testing/iotest"
	"time"
)

// TestMain makes the test binary its own child, the way main makes shorted.
func TestMain(m *testing.M) {
	if handled, code := Serve(testModes); handled {
		os.Exit(code)
	}
	os.Exit(m.Run())
}

var sink [][]byte

var testModes = map[string]Extract{
	// echo returns the document and the page limit it was asked for.
	"echo": func(data []byte, maxPages int) (string, error) {
		return strconv.Itoa(maxPages) + ":" + string(data), nil
	},
	// balloon is a reader that never stops allocating: a decompression bomb.
	"balloon": func([]byte, int) (string, error) {
		for {
			b := make([]byte, 16<<20)
			for i := range b {
				b[i] = 1
			}
			sink = append(sink, b)
		}
	},
	// spin is a reader stuck in a loop that allocates nothing.
	"spin": func([]byte, int) (string, error) {
		for {
			time.Sleep(time.Millisecond)
		}
	},
	"fail": func([]byte, int) (string, error) {
		return "", errors.New("open pdf: malformed xref")
	},
}

func TestReadStreamsTheDocumentToAChild(t *testing.T) {
	r := NewReader("echo", 512<<20)
	// A reader that is not a bytes.Reader and returns one byte at a time: the
	// child must get the document whole however the parent's source delivers it.
	doc := "%PDF-1.7 " + strings.Repeat("x", 100_000)
	got, err := r.Read(context.Background(), iotest.OneByteReader(strings.NewReader(doc)), int64(len(doc)), 7)
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if got != "7:"+doc {
		t.Fatalf("child returned %d bytes, want %d", len(got), len(doc)+2)
	}
}

func TestReadKillsAChildPastItsAllowance(t *testing.T) {
	if _, ok := residentBytes("/proc/self/status"); !ok {
		t.Skip("no /proc: the deadline is the bound here")
	}
	r := NewReader("balloon", 0)
	start := time.Now()
	_, err := r.Read(context.Background(), strings.NewReader("%PDF-"), 5, 3)
	if err == nil || !strings.Contains(err.Error(), "resident") {
		t.Fatalf("err = %v, want the child killed for its resident set", err)
	}
	if d := time.Since(start); d > 30*time.Second {
		t.Fatalf("took %s to stop a ballooning child", d)
	}
}

func TestReadStopsAChildThatLoops(t *testing.T) {
	r := NewReader("spin", 0)
	r.timeout = 300 * time.Millisecond
	_, err := r.Read(context.Background(), strings.NewReader("%PDF-"), 5, 3)
	if err == nil || !strings.Contains(err.Error(), "stopped after") {
		t.Fatalf("err = %v, want the deadline to stop the child", err)
	}
}

func TestReadReportsTheChildsError(t *testing.T) {
	_, err := NewReader("fail", 0).Read(context.Background(), strings.NewReader("%PDF-"), 5, 3)
	if err == nil || !strings.Contains(err.Error(), "malformed xref") {
		t.Fatalf("err = %v, want the child's own message", err)
	}
	_, err = NewReader("no-such-mode", 0).Read(context.Background(), strings.NewReader("%PDF-"), 5, 3)
	if err == nil || !strings.Contains(err.Error(), "unknown mode") {
		t.Fatalf("err = %v, want an unknown mode refused", err)
	}
}

func TestReadWaitsForBudget(t *testing.T) {
	r := NewReader("echo", 0) // one smallest allowance
	if err := r.budget.Acquire(context.Background(), r.total); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	if _, err := r.Read(ctx, strings.NewReader("%PDF-"), 5, 1); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("err = %v, want Read to wait for the budget until its context ends", err)
	}
	r.budget.Release(r.total)
}

func TestAllowance(t *testing.T) {
	for _, c := range []struct {
		n    int64
		want int64
	}{
		{100 << 10, minAllowance},
		{10 << 20, baseAllowance + (10<<20)*perByte},
		{60 << 20, maxAllowance},
		{-1, maxAllowance},
	} {
		if got := Allowance(c.n); got != c.want {
			t.Errorf("Allowance(%d) = %d, want %d", c.n, got, c.want)
		}
	}
}

func TestLimitedBufferNeverFailsTheWriter(t *testing.T) {
	lb := &limitedBuffer{buf: new(bytes.Buffer), max: 4}
	n, err := io.WriteString(lb, "abcdefgh")
	if n != 8 || err != nil {
		t.Fatalf("Write = %d, %v; want 8, nil", n, err)
	}
	if got := lb.buf.String(); got != "abcd" {
		t.Fatalf("kept %q, want abcd", got)
	}
}
