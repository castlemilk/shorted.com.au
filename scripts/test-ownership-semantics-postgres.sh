#!/usr/bin/env bash
# Run the semantic sidecar's real-Postgres tests against a new throwaway database.
# Requires Bash, Docker, Go 1.27+, Python 3 and GNU timeout. No existing DSN or
# application credentials are used. CI calls this same local entry point.
set -euo pipefail

if [[ $# -ne 0 ]]; then
  echo "Usage: bash scripts/test-ownership-semantics-postgres.sh" >&2
  exit 2
fi

OWNERSHIP_TEST_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
OWNERSHIP_TEST_GO="${OWNERSHIP_SEMANTICS_GO_BIN:-go}"
for OWNERSHIP_TEST_TOOL in docker python3 timeout "$OWNERSHIP_TEST_GO"; do
  if ! command -v "$OWNERSHIP_TEST_TOOL" >/dev/null 2>&1; then
    echo "Required test tool is unavailable: $OWNERSHIP_TEST_TOOL" >&2
    exit 1
  fi
done

# This package uses public dependencies only. In particular, do not run a
# repository-wide go mod download or install private Git authentication.
export GOWORK=off GOENV=off GOFLAGS=-mod=readonly GOTOOLCHAIN=local
export GOPROXY=https://proxy.golang.org GOSUMDB=sum.golang.org
export GOPRIVATE= GONOPROXY= GONOSUMDB= GOVCS='*:off' GIT_TERMINAL_PROMPT=0
if [[ "$("$OWNERSHIP_TEST_GO" version)" != "go version go"* ]]; then
  echo "The selected Go executable is not the Go toolchain." >&2
  exit 1
fi
timeout 15s docker info >/dev/null

OWNERSHIP_TEST_TMP="$(mktemp -d "${TMPDIR:-/tmp}/shorted-ownership-semantics.XXXXXXXX")"
OWNERSHIP_TEST_CONTAINER="shorted-ownership-semantics-$$-$RANDOM"
OWNERSHIP_TEST_CONTAINER_STARTED=0
cleanup() {
  local result=$?
  trap - EXIT INT TERM
  set +e
  if [[ "$OWNERSHIP_TEST_CONTAINER_STARTED" == 1 ]]; then
    if [[ "$result" != 0 ]]; then
      timeout 10s docker logs --tail 40 "$OWNERSHIP_TEST_CONTAINER" >&2
    fi
    if ! timeout 20s docker rm --force --volumes "$OWNERSHIP_TEST_CONTAINER" >/dev/null; then
      echo "Could not remove the owned throwaway PostgreSQL container." >&2
      [[ "$result" == 0 ]] && result=1
    fi
  fi
  rm -rf -- "$OWNERSHIP_TEST_TMP"
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  # CI retains this one owned name for an always-run cleanup step as well.
  printf 'container_name=%s\n' "$OWNERSHIP_TEST_CONTAINER" >> "$GITHUB_OUTPUT"
fi

# Match the repository's ephemeral integration-image family. The container
# has a unique task-owned name, an in-memory data directory and only a
# loopback random host port; it never mounts a developer's database volume.
if ! timeout 15s docker image inspect postgres:15-alpine >/dev/null 2>&1; then
  timeout 180s docker pull postgres:15-alpine
fi
# Mark before starting so a client timeout after daemon-side creation still
# runs cleanup for this unique container name.
OWNERSHIP_TEST_CONTAINER_STARTED=1
timeout 30s docker run --detach --rm \
  --name "$OWNERSHIP_TEST_CONTAINER" \
  --label shorted.test=ownership-semantics \
  --tmpfs /var/lib/postgresql/data \
  --publish 127.0.0.1::5432 \
  --env POSTGRES_USER=ownership_semantics \
  --env POSTGRES_PASSWORD=ownership_semantics_local_only \
  --env POSTGRES_DB=shorted_ownership_semantics_test \
  postgres:15-alpine >/dev/null

OWNERSHIP_TEST_READY=0
OWNERSHIP_TEST_READY_DEADLINE=$((SECONDS + 60))
while (( SECONDS < OWNERSHIP_TEST_READY_DEADLINE )); do
  if timeout 5s docker exec "$OWNERSHIP_TEST_CONTAINER" \
      pg_isready --username ownership_semantics --dbname shorted_ownership_semantics_test >/dev/null 2>&1; then
    OWNERSHIP_TEST_READY=1
    break
  fi
  sleep 1
done
if [[ "$OWNERSHIP_TEST_READY" != 1 ]]; then
  echo "Throwaway PostgreSQL did not become ready within 60 seconds." >&2
  exit 1
fi
OWNERSHIP_TEST_BINDING="$(timeout 10s docker port "$OWNERSHIP_TEST_CONTAINER" 5432/tcp)"
if [[ ! "$OWNERSHIP_TEST_BINDING" =~ ^127\.0\.0\.1:([0-9]+)$ ]]; then
  echo "Throwaway PostgreSQL did not expose the requested loopback test port." >&2
  exit 1
fi
OWNERSHIP_TEST_PORT="${BASH_REMATCH[1]}"
export OWNERSHIP_SEMANTICS_TEST_DATABASE_URL="postgres://ownership_semantics:ownership_semantics_local_only@127.0.0.1:${OWNERSHIP_TEST_PORT}/shorted_ownership_semantics_test?sslmode=disable&connect_timeout=5&statement_timeout=15000&lock_timeout=5000"
export OWNERSHIP_SEMANTICS_REQUIRE_DATABASE=1

echo "Running ownership semantic revisions against throwaway PostgreSQL."
cd -- "$OWNERSHIP_TEST_ROOT/services"
timeout 300s "$OWNERSHIP_TEST_GO" test -json -count=1 -timeout=180s \
  -run '^TestPostgresSemanticRevisions$' ./pkg/ownershipsemantics \
  | tee "$OWNERSHIP_TEST_TMP/go-test.jsonl"

# go test exits successfully when a selector matches no tests or a DB test
# calls Skip. Require the named real database test to pass, with no skipped
# subtests, rather than treating either situation as integration evidence.
python3 - "$OWNERSHIP_TEST_TMP/go-test.jsonl" <<'PY'
import json
import sys

target = "TestPostgresSemanticRevisions"
passed = False
package_passed = False
with open(sys.argv[1], encoding="utf-8") as events:
    for line in events:
        event = json.loads(line)
        action, name = event.get("Action"), event.get("Test", "")
        if action == "skip" and (name == target or name.startswith(target + "/")):
            raise SystemExit("Required real-Postgres test or subtest was skipped.")
        if action == "fail":
            raise SystemExit("The real-Postgres test stream contains a failure.")
        if action == "pass" and name == target:
            passed = True
        if action == "pass" and not name:
            package_passed = True
if not passed or not package_passed:
    raise SystemExit("No passing TestPostgresSemanticRevisions result; database verification did not run.")
print("Verified TestPostgresSemanticRevisions passed without skipped database checks.")
PY
