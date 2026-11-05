//go:build !testcontainers

package testpostgres

import "errors"

var errNoContainers = errors.New("a *_TESTCONTAINERS=1 opt-in needs the testcontainers build tag: go test -tags=testcontainers")

// Without the testcontainers tag there is no container to start or remove. The
// opt-in fails loudly rather than letting a suite skip while it believes it has one.
func startContainer() (string, error) { return "", errNoContainers }

func terminateContainer() {}
