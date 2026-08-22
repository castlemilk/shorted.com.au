import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const checker = join(repoRoot, "scripts/check-portal-content-provenance.mjs");
const generator = join(repoRoot, "scripts/generate-synthetic-housing-pagemeta-fixtures.mjs");
const workflow = join(repoRoot, ".github/workflows/repo-hygiene.yml");
const fixturePaths = [
  "services/house-price-collector/testdata/rea-pagemeta.html",
  "services/house-price-collector/testdata/domain-pagemeta.html",
  "services/jobs/internal/jobs/houseprices/testdata/rea-pagemeta.html",
  "services/jobs/internal/jobs/houseprices/testdata/domain-pagemeta.html",
];

function temporaryRoot() {
  return mkdtempSync(join(tmpdir(), "shorted-portal-provenance-"));
}

function write(root, path, contents) {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, contents);
}

function run(script, root) {
  return spawnSync(process.execPath, [script, "--root", root], {
    cwd: repoRoot,
    encoding: "utf8",
  });
}

function output(result) {
  return `${result.stdout}\n${result.stderr}`;
}

test("rejects captured REA bootstrap markup with its relative path and signature", () => {
  const root = temporaryRoot();
  const path = "services/example/testdata/rea-capture.html";
  write(root, path, `<script>window.ArgonautExchange = {"captured":true};</script>`);

  const result = run(checker, root);

  assert.notEqual(result.status, 0, output(result));
  assert.match(output(result), /REA Argonaut bootstrap/i);
  assert.match(output(result), new RegExp(path.replaceAll("/", "\\/")));
  assert.doesNotMatch(output(result), new RegExp(root.replaceAll("/", "\\/")));
});

test("rejects captured REA search payloads in nonstandard fixture extensions", () => {
  const root = temporaryRoot();
  const path = "services/example/testdata/rea-capture.fixture";
  write(root, path, `<script>{"canonicalSearchId":"captured-search-identity"}</script>`);

  const result = run(checker, root);

  assert.notEqual(result.status, 0, output(result));
  assert.match(output(result), /REA canonical search payload/i);
  assert.match(output(result), new RegExp(path.replaceAll("/", "\\/")));
});

test("scans service source files outside testdata", () => {
  const root = temporaryRoot();
  const path = "services/example/captured_listing_test.go";
  write(root, path, `const captured = \`{"canonicalSearchId":"captured-search-identity"}\``);

  const result = run(checker, root);

  assert.notEqual(result.status, 0, output(result));
  assert.match(output(result), /REA canonical search payload/i);
  assert.match(output(result), new RegExp(path.replaceAll("/", "\\/")));
});

test("rejects captured Domain search bootstrap markup with its relative path and signature", () => {
  const root = temporaryRoot();
  const path = "web/test-fixtures/domain-capture.html";
  write(
    root,
    path,
    `<script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"totalListings":12,"pageViewMetadata":{"searchRequest":{"pageSize":20}}}}}</script>`,
  );

  const result = run(checker, root);

  assert.notEqual(result.status, 0, output(result));
  assert.match(output(result), /Domain search bootstrap/i);
  assert.match(output(result), new RegExp(path.replaceAll("/", "\\/")));
});

test("rejects captured Domain search bootstrap markup in snapshot files", () => {
  const root = temporaryRoot();
  const path = "web/test-fixtures/domain-capture.snap";
  write(
    root,
    path,
    `<script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"totalListings":12,"pageViewMetadata":{"searchRequest":{"pageSize":20}}}}}</script>`,
  );

  const result = run(checker, root);

  assert.notEqual(result.status, 0, output(result));
  assert.match(output(result), /Domain search bootstrap/i);
  assert.match(output(result), new RegExp(path.replaceAll("/", "\\/")));
});

test("allows ordinary portal hyperlinks and source attribution", () => {
  const root = temporaryRoot();
  write(
    root,
    "web/source-attribution.html",
    `<a href="https://www.realestate.com.au/">REA source</a><a href="https://www.domain.com.au/">Domain source</a>`,
  );

  const result = run(checker, root);

  assert.equal(result.status, 0, output(result));
});

test("allows the REA property-not-found route", () => {
  const root = temporaryRoot();
  write(root, "services/example/crawl_test.go", `const removed = "https://www.realestate.com.au/property-not-found"`);

  const result = run(checker, root);

  assert.equal(result.status, 0, output(result));
});

test("allows synthetic structural pagination data", () => {
  const root = temporaryRoot();
  write(
    root,
    "services/example/testdata/synthetic.html",
    `<script>window.SyntheticHousingPageMeta = {"totalResultsCount":47,"listings_total":7,"pagination":{"maxPageNumberAvailable":3},"metadata":"{\\"savedSearchQuery\\":\\"{\\\\\\"pageSize\\\\\\":20,\\\\\\"filters\\\\\\":{\\\\\\"surroundingSuburbs\\\\\\":true}}\\"}"};</script>`,
  );
  write(
    root,
    "web/synthetic-domain-shape.html",
    `<script id="__SYNTHETIC_PAGE_META__" type="application/json">{"componentProps":{"totalResults":43,"totalPages":3,"pageSize":20,"locations":[{"includeSurroundingSuburbs":true}],"results":[]}}</script>`,
  );

  const result = run(checker, root);

  assert.equal(result.status, 0, output(result));
});

test("allows portal wrapper syntax only in explicit parser-shape test files", () => {
  const root = temporaryRoot();
  write(
    root,
    "services/house-price-collector/crawl_listings_test.go",
    `const synthetic = \`<script>window.ArgonautExchange = {"fixtureProvenance":"synthetic"};</script>\``,
  );

  const result = run(checker, root);

  assert.equal(result.status, 0, output(result));
});

test("rejects captured listing content independently of portal wrapper names", async (t) => {
  const cases = [
    {
      name: "REA canonical listing URL",
      signature: /REA canonical listing URL/i,
      contents: `window.RenamedBootstrap = {"url":"https://www.realestate.com.au/property-house-vic-exampleville-123456789"}`,
    },
    {
      name: "Domain canonical listing URL",
      signature: /Domain canonical listing URL/i,
      contents: `window.RenamedBootstrap = {"url":"https://www.domain.com.au/example-avenue-exampleville-vic-3000-123456789"}`,
    },
    {
      name: "numbered listing address",
      signature: /numbered listing address/i,
      contents: `window.RenamedBootstrap = {"fullAddress":"10 Example Avenue, Exampleville, VIC 3000"}`,
    },
    {
      name: "Australian listing locality",
      signature: /Australian listing locality/i,
      contents: `window.RenamedBootstrap = {"listingcompany":{"name":"Example Realty"},"state":"VIC","postcode":"3000"}`,
    },
  ];

  for (const fixture of cases) {
    await t.test(fixture.name, () => {
      const root = temporaryRoot();
      const path = "services/house-price-collector/crawl_listings_test.go";
      write(root, path, fixture.contents);

      const result = run(checker, root);

      assert.notEqual(result.status, 0, output(result));
      assert.match(output(result), fixture.signature);
      assert.match(output(result), new RegExp(path.replaceAll("/", "\\/")));
    });
  }
});

test("Git checkouts scan every tracked extension without traversing untracked dependency output", () => {
  const root = temporaryRoot();
  const trackedPath = "web/tracked-capture.fixture";
  write(root, trackedPath, `<script>window.ArgonautExchange = {"captured":true};</script>`);
  // Same trap the checker itself hit: `git -C` does not override an inherited
  // GIT_DIR, and this suite runs from the pre-commit/pre-push hooks, which set
  // one. Without stripping it these commands operate on the real repository.
  const gitEnv = { ...process.env };
  for (const key of Object.keys(gitEnv)) {
    if (key.startsWith("GIT_")) delete gitEnv[key];
  }
  const init = spawnSync("git", ["-C", root, "init", "--quiet"], { encoding: "utf8", env: gitEnv });
  assert.equal(init.status, 0, output(init));
  const add = spawnSync("git", ["-C", root, "add", trackedPath], { encoding: "utf8", env: gitEnv });
  assert.equal(add.status, 0, output(add));

  const trackedResult = run(checker, root);
  assert.notEqual(trackedResult.status, 0, output(trackedResult));
  assert.match(output(trackedResult), new RegExp(trackedPath.replaceAll("/", "\\/")));

  write(root, trackedPath, `<a href="https://www.realestate.com.au/">source attribution</a>`);
  write(
    root,
    "web/node_modules/generated-capture.snap",
    `<script>window.ArgonautExchange = {"captured":true};</script>`,
  );
  const untrackedResult = run(checker, root);
  assert.equal(untrackedResult.status, 0, output(untrackedResult));
});

test("checker passes the current checkout", () => {
  const result = run(checker, repoRoot);

  assert.equal(result.status, 0, output(result));
});

test("workflow runs the provenance tests and gate for every protected path", () => {
  const source = readFileSync(workflow, "utf8");

  for (const protectedPath of [
    "services/**",
    "web/**",
    "docs/housing-architecture.md",
    "scripts/check-portal-content-provenance.mjs",
    "scripts/generate-synthetic-housing-pagemeta-fixtures.mjs",
    "scripts/tests/housing-deploy-hygiene.test.mjs",
    "scripts/tests/portal-content-provenance.test.mjs",
    ".github/workflows/repo-hygiene.yml",
  ]) {
    assert.match(
      source,
      new RegExp(`^\\s+- ["']${protectedPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']\\s*$`, "m"),
    );
  }
  assert.match(source, /actions\/checkout@v5/);
  assert.match(source, /actions\/setup-node@v5/);
  assert.match(source, /node-version:\s*["']?24\b/);
  assert.match(
    source,
    /node --test scripts\/tests\/portal-content-provenance\.test\.mjs scripts\/tests\/housing-deploy-hygiene\.test\.mjs/,
  );
  assert.match(source, /node scripts\/check-portal-content-provenance\.mjs/);
});

test("generator deterministically reproduces all four committed fixtures", () => {
  const root = temporaryRoot();
  const firstRun = run(generator, root);
  assert.equal(firstRun.status, 0, output(firstRun));

  const firstContents = new Map();
  for (const path of fixturePaths) {
    const generated = readFileSync(join(root, path));
    firstContents.set(path, generated);
    assert.deepEqual(
      generated,
      readFileSync(join(repoRoot, path)),
      `${relative(repoRoot, generator)} did not reproduce ${path}`,
    );
  }

  const secondRun = run(generator, root);
  assert.equal(secondRun.status, 0, output(secondRun));
  for (const path of fixturePaths) {
    assert.deepEqual(readFileSync(join(root, path)), firstContents.get(path), `${path} changed between generator runs`);
  }
  assert.deepEqual(firstContents.get(fixturePaths[0]), firstContents.get(fixturePaths[2]));
  assert.deepEqual(firstContents.get(fixturePaths[1]), firstContents.get(fixturePaths[3]));
});
