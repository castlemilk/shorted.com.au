package shorts

import (
	"strings"
	"testing"
)

// checkDockerError checks if an error is Docker-related and skips the test if so.
// This allows tests to gracefully skip when Docker is not available.
func checkDockerError(t *testing.T, err error) {
	t.Helper()
	if err == nil {
		return
	}
	
	// Check if error is Docker-related
	errMsg := strings.ToLower(err.Error())
	if strings.Contains(errMsg, "docker") || 
	   strings.Contains(errMsg, "cannot connect") ||
	   strings.Contains(errMsg, "daemon") ||
	   strings.Contains(errMsg, "is the docker daemon running") {
		t.Skipf("Docker is not available (required for integration tests): %v", err)
	}
}
