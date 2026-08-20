import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { access } from "node:fs/promises";
import test from "node:test";

function read(path) {
  return readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
}

test("git hooks delegate to the local verifier instead of booting services inline", () => {
  const installer = read("scripts/install-hooks.sh");

  assert.match(installer, /scripts\/local-verify\.sh"\s+pre-commit/);
  assert.match(installer, /scripts\/local-verify\.sh"\s+pre-push/);
  assert.doesNotMatch(installer, /go run shorts\/cmd\/server\/main\.go/);
  assert.doesNotMatch(installer, /docker compose up -d postgres/);
});

test("local verifier keeps frontend builds backend-free and exposes testcontainer lanes", async () => {
  await access(new URL("../../scripts/local-verify.sh", import.meta.url));
  const verifier = read("scripts/local-verify.sh");

  assert.match(verifier, /SKIP_STATIC_GENERATION=1/);
  assert.match(verifier, /SKIP_VERSION_BUMP=1/);
  assert.match(verifier, /SKIP_CACHE_WARM=1/);
  assert.match(verifier, /127\.0\.0\.1:65535/);
  assert.match(verifier, /LOCAL_VERIFY_ALLOW_EXTERNAL/);
  assert.match(verifier, /REDIS_URL=""/);
  assert.match(verifier, /make test-integration-local/);
  assert.match(verifier, /LOCAL_VERIFY_INTEGRATION/);
  assert.doesNotMatch(verifier, /go run shorts\/cmd\/server\/main\.go/);
  assert.doesNotMatch(verifier, /docker compose up -d postgres/);
});

test("testcontainers integration targets force real uncached runs", () => {
  const servicesMakefile = read("services/Makefile");

  assert.match(
    servicesMakefile,
    /cd \.\.\/test\/integration && go test -v -count=1 -timeout=20m \.\/\.\.\./,
  );
  assert.match(
    servicesMakefile,
    /cd market-data && go test -v -count=1 -tags=integration -timeout=10m \.\/\.\.\./,
  );
  assert.doesNotMatch(servicesMakefile, /test-integration-local:[\s\S]*go test -v -timeout=20m/);
});

test("static generation fetchers respect the local verifier skip flag", () => {
  // The shared guard owns the env check — and must be build-phase-only:
  // SKIP_STATIC_GENERATION=1 is set project-wide on Vercel AT RUNTIME, so a
  // raw env check permanently blanks ISR pages (July 2026 sitemap/directory/
  // market regression).
  const config = read("web/src/app/actions/config.ts");
  assert.match(config, /SKIP_STATIC_GENERATION/);
  assert.match(config, /phase-production-build/);

  // Every static-generation fetcher must consult the shared guard, not the
  // raw env var. Guard the fetcher that owns the build-time skip — for the
  // directory that is the shared data module (directory-data.ts), not the
  // [letter] page, which only delegates to it.
  const files = [
    "web/src/@/lib/seo/sitemap-sections.ts",
    "web/src/app/directory/directory-data.ts",
    "web/src/app/market/page.tsx",
    "web/src/app/actions/industry/getIndustryData.ts",
  ];

  for (const file of files) {
    const source = read(file);
    assert.match(source, /skipForBuild/);
    assert.doesNotMatch(
      source,
      /process\.env\.SKIP_STATIC_GENERATION/,
      `${file} must use skipForBuild() from actions/config.ts, not the raw env var`,
    );
  }
});

test("local verifier bounds slow probes and reports section durations", () => {
  const verifier = read("scripts/local-verify.sh");

  assert.match(verifier, /LOCAL_VERIFY_DOCKER_TIMEOUT/);
  assert.match(verifier, /SECONDS/);
  assert.match(verifier, /duration/);
  assert.match(verifier, /run_lint\(\) \{[\s\S]*ensure_node_deps[\s\S]*Frontend lint/);
});

test("all self-contained integration make targets avoid cached go test results", () => {
  const rootMakefile = read("Makefile");
  const servicesMakefile = read("services/Makefile");

  assert.match(
    rootMakefile,
    /cd test\/integration && go mod download && go test -v -count=1 \.\/\.\.\./,
  );
  assert.match(
    servicesMakefile,
    /go test -count=1 -tags=integration \.\/test\/integration\/\.\.\. -v -timeout=10m/,
  );
  assert.match(
    servicesMakefile,
    /go test -count=1 -tags=integration \.\/test\/integration\/\.\.\. -v -timeout=10m -coverprofile=integration-coverage\.out/,
  );
});
