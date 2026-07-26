package reportextract

import (
	"fmt"
	"os"
	"strconv"
	"strings"
)

// Env var names for the paid-Gemini run budget. Both deployed Cloud Run Jobs set
// these, so the names are a deployment contract.
const (
	envMaxRunItems   = "GEMINI_MAX_RUN_ITEMS"
	envMaxRunWorkers = "GEMINI_MAX_RUN_WORKERS"
)

// positiveIntEnv is extract.py's _positive_int_env: unset/blank falls back to
// the default; anything else must parse as a POSITIVE integer or the run fails.
// A misconfigured budget must not silently degrade to "unlimited".
func positiveIntEnv(name string, def int) (int, error) {
	raw, ok := os.LookupEnv(name)
	if !ok || strings.TrimSpace(raw) == "" {
		return def, nil
	}
	value, err := strconv.Atoi(raw)
	if err != nil {
		return 0, fmt.Errorf("%s must be a positive integer", name)
	}
	if value <= 0 {
		return 0, fmt.Errorf("%s must be a positive integer", name)
	}
	return value, nil
}

// resolveGeminiRunBudget caps paid Gemini batch size/concurrency even when the
// CLI args are too broad — extract.py's resolve_gemini_run_budget, including its
// treatment of limit<=0 ("unlimited") as "clamp to the cap".
//
//	guardedLimit   = maxItems when limit <= 0 or limit > maxItems, else limit
//	guardedWorkers = min(max(workers, 1), maxWorkers)
func resolveGeminiRunBudget(limit, workers, defaultMaxItems, defaultMaxWorkers int) (int, int, error) {
	maxItems, err := positiveIntEnv(envMaxRunItems, defaultMaxItems)
	if err != nil {
		return 0, 0, err
	}
	maxWorkers, err := positiveIntEnv(envMaxRunWorkers, defaultMaxWorkers)
	if err != nil {
		return 0, 0, err
	}

	guardedLimit := limit
	if limit <= 0 || limit > maxItems {
		guardedLimit = maxItems
	}
	guardedWorkers := workers
	if guardedWorkers < 1 {
		guardedWorkers = 1
	}
	if guardedWorkers > maxWorkers {
		guardedWorkers = maxWorkers
	}
	return guardedLimit, guardedWorkers, nil
}
