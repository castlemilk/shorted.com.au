package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestRunHousingVGNSWWrapperLoadsEnvAndPropagatesExit(t *testing.T) {
	tmp := t.TempDir()
	fakeBin := filepath.Join(tmp, "fake-house-price-collector")
	capture := filepath.Join(tmp, "capture.txt")
	logPath := filepath.Join(tmp, "housing-vg-nsw.log")
	envPath := filepath.Join(tmp, "housing-vg.env")

	fake := `#!/usr/bin/env bash
printf 'args=%s\ndatabase=%s\ntimeout=%s\n' "$*" "$DATABASE_URL" "$VG_NSW_TIMEOUT_MIN" > "$VG_NSW_TEST_CAPTURE"
exit "${VG_NSW_TEST_EXIT:-0}"
`
	if err := os.WriteFile(fakeBin, []byte(fake), 0o755); err != nil {
		t.Fatal(err)
	}
	envFile := fmt.Sprintf(
		"DATABASE_URL=%q\nHOUSING_VG_BIN=%q\nHOUSING_VG_LOG=%q\nVG_NSW_TIMEOUT_MIN=17\n",
		"postgresql://collector:test@db.example/shorted",
		fakeBin,
		logPath,
	)
	if err := os.WriteFile(envPath, []byte(envFile), 0o600); err != nil {
		t.Fatal(err)
	}

	cmd := exec.Command("/bin/bash", "deploy/run-housing-vg-nsw.sh")
	cmd.Env = append(os.Environ(),
		"HOUSING_VG_ENV="+envPath,
		"VG_NSW_TEST_CAPTURE="+capture,
		"VG_NSW_TEST_EXIT=7",
	)
	output, err := cmd.CombinedOutput()
	var exitErr *exec.ExitError
	if !errors.As(err, &exitErr) || exitErr.ExitCode() != 7 {
		t.Fatalf("wrapper error = %v, output = %s; want exit 7", err, output)
	}

	gotCapture, err := os.ReadFile(capture)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		"args=-mode vg-nsw",
		"database=postgresql://collector:test@db.example/shorted",
		"timeout=17",
	} {
		if !strings.Contains(string(gotCapture), want) {
			t.Errorf("capture %q does not contain %q", gotCapture, want)
		}
	}

	gotLog, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"housing-vg-nsw", "vg_nsw rc=7"} {
		if !strings.Contains(string(gotLog), want) {
			t.Errorf("log %q does not contain %q", gotLog, want)
		}
	}
}
