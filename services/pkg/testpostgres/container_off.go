//go:build !testcontainers

package testpostgres

import "errors"

var errNoContainers = errors.New("ALERTS_E2E_TESTCONTAINERS=1 needs the testcontainers build tag: go test -tags=testcontainers")

// Without the testcontainers tag there is no container to start or remove. The
// opt-in fails loudly rather than letting a suite skip while it believes it has one.
func startContainer() (string, error) { return "", errNoContainers }

func terminateContainer() {}
