package main

// crawl_driver_install_test.go tests the REAL driver installer against stub downloads. playwright-go reads
// PLAYWRIGHT_GO_NPM_REGISTRY (the playwright-core package) and NODE_MIRROR (the node archive), so a local
// HTTP server serves both, and the install downloads from it exactly as it would from npm and nodejs.org.

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

// driverInstallCmdEnv makes the test binary run runInstallDriver(false) and exit with its code, so a
// concurrent install can be a real second process (testmain_test.go).
const driverInstallCmdEnv = "CYCLE_TEST_INSTALL_CMD"

// stubRegistry serves the two downloads a driver install makes. It counts them, and can stall the package
// download, so a test can hold an install in progress.
type stubRegistry struct {
	srv      *httptest.Server
	mu       sync.Mutex
	pkgHits  int
	nodeHits int
	slowPkg  time.Duration
	pkgSeen  chan struct{}
	once     sync.Once
}

// newStubRegistry starts the stub and points the installer at it. slowPkg delays the package download.
func newStubRegistry(t *testing.T, slowPkg time.Duration) *stubRegistry {
	t.Helper()
	version := mustDriverVersion()
	pkg := stubPackageTgz(version)
	r := &stubRegistry{slowPkg: slowPkg, pkgSeen: make(chan struct{})}
	r.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		switch {
		case strings.HasSuffix(req.URL.Path, ".tgz"):
			r.mu.Lock()
			r.pkgHits++
			r.mu.Unlock()
			r.once.Do(func() { close(r.pkgSeen) })
			if r.slowPkg > 0 {
				time.Sleep(r.slowPkg)
			}
			_, _ = w.Write(pkg)
		case strings.HasSuffix(req.URL.Path, ".tar.gz"):
			r.mu.Lock()
			r.nodeHits++
			r.mu.Unlock()
			// The archive's top directory is named by the request path, as nodejs.org names it.
			archiveDir := strings.TrimSuffix(filepath.Base(req.URL.Path), ".tar.gz")
			_, _ = w.Write(stubNodeArchive(archiveDir, version))
		default:
			http.NotFound(w, req)
		}
	}))
	t.Cleanup(r.srv.Close)
	t.Setenv("PLAYWRIGHT_GO_NPM_REGISTRY", r.srv.URL)
	t.Setenv("NODE_MIRROR", r.srv.URL)
	return r
}

// counts returns the package and node downloads served so far.
func (r *stubRegistry) counts() (pkg, node int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.pkgHits, r.nodeHits
}

// stubPackageTgz is a playwright-core package: package/package.json at version, and package/cli.js. The
// node stub prints version, so `node cli.js --version` reports it, which is the library's own check.
func stubPackageTgz(version string) []byte {
	return tgzArchive(map[string]tarFile{
		"package/package.json": {mode: 0o644, body: `{"name":"playwright-core","version":"` + version + `"}`},
		"package/cli.js":       {mode: 0o644, body: "// stub\n"},
	})
}

// stubNodeArchive is a node distribution: <archiveDir>/bin/node, which prints version.
func stubNodeArchive(archiveDir, version string) []byte {
	return tgzArchive(map[string]tarFile{
		archiveDir + "/bin/node": {mode: 0o755, body: "#!/bin/sh\necho " + version + "\n"},
	})
}

type tarFile struct {
	mode int64
	body string
}

// tgzArchive builds a gzipped tar of files. A test helper, so an error panics.
func tgzArchive(files map[string]tarFile) []byte {
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	for name, f := range files {
		if err := tw.WriteHeader(&tar.Header{Name: name, Mode: f.mode, Size: int64(len(f.body)), Typeflag: tar.TypeReg}); err != nil {
			panic(err)
		}
		if _, err := tw.Write([]byte(f.body)); err != nil {
			panic(err)
		}
	}
	if err := tw.Close(); err != nil {
		panic(err)
	}
	if err := gz.Close(); err != nil {
		panic(err)
	}
	return buf.Bytes()
}

// installTestEnv points the driver at a fresh directory and the stub registry.
func installTestEnv(t *testing.T) (string, *stubRegistry) {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "pw-driver")
	t.Setenv("CRAWL_PW_DRIVER_DIR", dir)
	return dir, newStubRegistry(t, 0)
}

// inodeOf is the directory's inode: a swap replaces it.
func inodeOf(t *testing.T, dir string) uint64 {
	t.Helper()
	fi, err := os.Stat(dir)
	if err != nil {
		t.Fatal(err)
	}
	return fi.Sys().(*syscall.Stat_t).Ino
}

// (1a) An up-to-date driver is a no-op: no download, and the directory is not swapped.
func TestInstallDriverDownloadsOnceThenIsANoOp(t *testing.T) {
	dir, reg := installTestEnv(t)
	if code := runInstallDriver(false); code != 0 {
		t.Fatalf("first install exit %d", code)
	}
	if pkg, node := reg.counts(); pkg != 1 || node != 1 {
		t.Fatalf("first install downloads: pkg=%d node=%d, want 1 and 1", pkg, node)
	}
	ino := inodeOf(t, dir)
	if code := runInstallDriver(false); code != 0 {
		t.Fatalf("second install exit %d", code)
	}
	if pkg, node := reg.counts(); pkg != 1 || node != 1 {
		t.Fatalf("an up-to-date install downloaded again: pkg=%d node=%d", pkg, node)
	}
	if inodeOf(t, dir) != ino {
		t.Fatalf("an up-to-date install swapped the live directory (its inode changed)")
	}
}

// (1a) Offline on a good directory exits 0: nothing is downloaded, so nothing can fail.
func TestInstallDriverOfflineOnAGoodDirExitsZero(t *testing.T) {
	_, _ = installTestEnv(t)
	if code := runInstallDriver(false); code != 0 {
		t.Fatalf("first install exit %d", code)
	}
	dead := httptest.NewServer(http.NotFoundHandler())
	deadURL := dead.URL
	dead.Close()
	t.Setenv("PLAYWRIGHT_GO_NPM_REGISTRY", deadURL)
	t.Setenv("NODE_MIRROR", deadURL)
	if code := runInstallDriver(false); code != 0 {
		t.Fatalf("an offline install of a good driver must exit 0, got %d", code)
	}
}

// (1a) -force reinstalls even when the driver verifies.
func TestInstallDriverForceDownloads(t *testing.T) {
	_, reg := installTestEnv(t)
	if code := runInstallDriver(false); code != 0 {
		t.Fatalf("first install exit %d", code)
	}
	if code := runInstallDriver(true); code != 0 {
		t.Fatalf("forced install exit %d", code)
	}
	if pkg, _ := reg.counts(); pkg != 2 {
		t.Fatalf("a forced install must download: pkg=%d, want 2", pkg)
	}
}

// (1b) A half-written directory is not up to date: the install replaces it.
func TestInstallDriverReplacesAHalfWrittenDir(t *testing.T) {
	dir, reg := installTestEnv(t)
	if err := os.MkdirAll(filepath.Join(dir, "package"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "package", "cli.js"), []byte("// partial\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if code := runInstallDriver(false); code != 0 {
		t.Fatalf("install over a half-written dir exit %d", code)
	}
	if pkg, _ := reg.counts(); pkg != 1 {
		t.Fatalf("a half-written dir must be reinstalled: pkg=%d, want 1", pkg)
	}
}

// (1b) A version mismatch is not up to date: the install replaces the driver.
func TestInstallDriverReplacesAVersionMismatch(t *testing.T) {
	dir, reg := installTestEnv(t)
	if code := runInstallDriver(false); code != 0 {
		t.Fatalf("first install exit %d", code)
	}
	if err := os.WriteFile(filepath.Join(dir, "package", "package.json"), []byte(`{"version":"0.0.0"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if code := runInstallDriver(false); code != 0 {
		t.Fatalf("install over a version mismatch exit %d", code)
	}
	if pkg, _ := reg.counts(); pkg != 2 {
		t.Fatalf("a version mismatch must be reinstalled: pkg=%d, want 2", pkg)
	}
}

// (2a) A second installer waits for the install lock, and gives up after the wait with exit 8.
func TestInstallDriverExitsEightWhileTheInstallLockIsHeld(t *testing.T) {
	dir, _ := installTestEnv(t)
	saved := installLockWait
	installLockWait = 300 * time.Millisecond
	t.Cleanup(func() { installLockWait = saved })
	if err := os.MkdirAll(filepath.Dir(dir), 0o755); err != nil {
		t.Fatal(err)
	}
	f, err := os.OpenFile(dir+".install.lock", os.O_CREATE|os.O_RDWR, 0o644)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = f.Close() }()
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = syscall.Flock(int(f.Fd()), syscall.LOCK_UN) }()
	if code := runInstallDriver(false); code != 8 {
		t.Fatalf("an install that cannot take the lock must exit 8, got %d", code)
	}
}

// (2a + 2b) Two real installers at once, the second starting one second after the first. The first is
// downloading slowly. Both end valid, the package is downloaded ONCE (the second waited, then saw a
// verified driver), and neither leaves or deletes the other's work.
func TestConcurrentInstallsSerialiseAndNeitherDeletesTheOther(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "pw-driver")
	t.Setenv("CRAWL_PW_DRIVER_DIR", dir)
	reg := newStubRegistry(t, 2*time.Second)
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	start := func() *exec.Cmd {
		cmd := exec.Command(self)
		cmd.Env = append(os.Environ(), driverInstallCmdEnv+"=1")
		cmd.Stderr = os.Stderr
		if err := cmd.Start(); err != nil {
			t.Fatal(err)
		}
		return cmd
	}
	a := start()
	<-reg.pkgSeen // A is in its download
	time.Sleep(time.Second)
	b := start()
	if err := a.Wait(); err != nil {
		t.Fatalf("installer A failed: %v", err)
	}
	if err := b.Wait(); err != nil {
		t.Fatalf("installer B failed: %v", err)
	}
	if pkg, _ := reg.counts(); pkg != 1 {
		t.Fatalf("the package was downloaded %d times: the second installer did not wait for the first", pkg)
	}
	version := mustDriverVersion()
	if err := verifyDriverDir(dir, version); err != nil {
		t.Fatalf("the live driver is not valid after both installs: %v", err)
	}
	if n := driverSiblings(dir); n != 0 {
		t.Fatalf("%d leftover temp or old dir(s) after both installs", n)
	}
}

// (2b) Cleanup keeps a temp or old directory whose pid is a live process (this test's own pid), and removes
// one whose pid is dead.
func TestCleanupKeepsADirOwnedByALiveProcess(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "pw-driver")
	parent, base := filepath.Dir(dir), filepath.Base(dir)
	live := filepath.Join(parent, base+driverTempInfix+strconv.Itoa(os.Getpid())+"-1")
	deadTemp := filepath.Join(parent, base+driverTempInfix+"2147483640-1")
	deadOld := filepath.Join(parent, base+driverOldInfix+"2147483640-5")
	for _, d := range []string{live, deadTemp, deadOld} {
		if err := os.Mkdir(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	removeStaleDriverDirs(dir)
	if _, err := os.Stat(live); err != nil {
		t.Fatalf("a temp dir owned by a live process was removed: %v", err)
	}
	for _, d := range []string{deadTemp, deadOld} {
		if _, err := os.Stat(d); err == nil {
			t.Fatalf("a dir owned by a dead process was kept: %s", d)
		}
	}
}
