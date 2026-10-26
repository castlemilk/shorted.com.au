package main

import (
	"os"
	"strconv"
	"syscall"
	"testing"
)

// flagsOf returns the fd's F_GETFD flags.
func flagsOf(t *testing.T, fd int) int {
	t.Helper()
	r, _, errno := syscall.Syscall(syscall.SYS_FCNTL, uintptr(fd), syscall.F_GETFD, 0)
	if errno != 0 {
		t.Fatalf("F_GETFD on fd %d: %v", fd, errno)
	}
	return int(r)
}

// The events fd must be close-on-exec: an exec'd child (the detached Chrome, the
// playwright driver) must not inherit the pipe, or a parent never sees EOF.
// Not parallel: a parallel test's fork could otherwise inherit the raw pipe.
func TestEventsFDIsCloseOnExec(t *testing.T) {
	var fds [2]int
	if err := syscall.Pipe(fds[:]); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = syscall.Close(fds[0]) }()
	if flagsOf(t, fds[1])&syscall.FD_CLOEXEC != 0 {
		t.Fatal("precondition: a raw syscall.Pipe fd starts without FD_CLOEXEC")
	}
	t.Setenv(crawlEventsFDEnv, strconv.Itoa(fds[1]))
	ev := newCrawlEventsFromEnv()
	if ev == nil {
		t.Fatalf("CRAWL_EVENTS_FD=%d must enable events", fds[1])
	}
	defer func() {
		if f, ok := ev.w.(*os.File); ok {
			_ = f.Close()
		}
	}()
	if flagsOf(t, fds[1])&syscall.FD_CLOEXEC == 0 {
		t.Fatal("the events fd must be close-on-exec")
	}
}
