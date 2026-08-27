import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// The spec is generated, and a generated artifact that can drift from its
// source is worse than a hand-written one: it looks authoritative while being
// wrong. Regenerate and diff.
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

const JSON_SPEC = "web/public/openapi.json";
const YAML_SPEC = "web/public/openapi.yaml";
// The markdown twin agents actually read. NOT `api.md`: a public file at that
// name collides with the `/docs/api.md` route and Next.js hard-errors with
// "A conflicting public file and page file was found".
const MARKDOWN_DOC = "web/public/docs/api-markdown.md";

const read = (relativePath) => readFileSync(join(repoRoot, relativePath), "utf8");

test("the published OpenAPI spec is up to date with the protos", (t) => {
  // Both twins are published; a stale YAML is exactly as wrong as a stale JSON,
  // and only the JSON gets read often enough for anyone to notice.
  const before = {
    json: read(JSON_SPEC),
    yaml: read(YAML_SPEC),
    markdown: read(MARKDOWN_DOC),
  };

  // Distinguish a broken toolchain from real drift. `make openapi` reaches the
  // Buf Schema Registry for remote plugins, so a BSR outage or an anonymous
  // rate limit fails here — and "the spec is stale" is exactly the wrong thing
  // for a hurried reader to conclude from that.
  //
  // In CI that is a hard failure — we cannot claim the spec is current when we
  // could not regenerate it. Locally it is a SKIP: this test runs in the
  // pre-push hook, and a rate limit on somebody else's registry must not be
  // able to stop an engineer pushing unrelated work. Blocking on that just
  // teaches everyone to reach for --no-verify, which costs us every other gate
  // in the hook.
  try {
    execFileSync("make", ["openapi"], { cwd: repoRoot, stdio: "inherit" });
  } catch (cause) {
    const message =
      "`make openapi` did not complete, so drift could not be assessed. " +
      "This is a TOOLCHAIN failure (buf, the BSR, or the Go build), NOT a stale spec — " +
      "see the command output above.";

    if (process.env.CI) throw new Error(message, { cause });

    t.skip(`${message} Skipping locally; CI enforces this.`);
    return;
  }

  const after = {
    json: read(JSON_SPEC),
    yaml: read(YAML_SPEC),
    markdown: read(MARKDOWN_DOC),
  };

  assert.equal(
    after.json,
    before.json,
    `${JSON_SPEC} is stale — run \`make openapi\` and commit the result`,
  );
  assert.equal(
    after.yaml,
    before.yaml,
    `${YAML_SPEC} is stale — run \`make openapi\` and commit the result`,
  );
  assert.equal(
    after.markdown,
    before.markdown,
    `${MARKDOWN_DOC} is stale — run \`make openapi\` and commit the result`,
  );
});

// Names that must never reach a document we publish. Matched CASE-SENSITIVELY
// and against the whole serialized document, not just the path keys: a
// previously-shipped bug left MintTokenRequest/MintTokenResponse sitting in
// components.schemas while no path referenced them, which a key-only check
// cannot see. Case matters — the Connect error-code enum legitimately contains
// the lowercase string "internal".
// Lowercase "admin" is included because it currently appears zero times, so it
// costs nothing; lowercase "internal" cannot be, for the enum reason above.
const FORBIDDEN = [
  "MintToken",
  "ShortedStocksService",
  "Admin",
  "admin",
  "Internal",
];

/** Every `$ref` string anywhere in the document, in document order. */
function collectRefs(node, path = "$", out = []) {
  if (Array.isArray(node)) {
    node.forEach((item, index) => collectRefs(item, `${path}[${index}]`, out));
    return out;
  }
  if (node === null || typeof node !== "object") return out;

  for (const [key, value] of Object.entries(node)) {
    if (key === "$ref" && typeof value === "string") {
      out.push({ ref: value, at: path });
      continue;
    }
    collectRefs(value, `${path}.${key}`, out);
  }
  return out;
}

test("the spec advertises no credential-issuing or internal endpoints", () => {
  const rawJson = read(JSON_SPEC);
  const rawYaml = read(YAML_SPEC);
  const spec = JSON.parse(rawJson);
  const paths = Object.keys(spec.paths);
  const schemas = Object.keys(spec.components?.schemas ?? {});

  assert.ok(paths.length > 30, `expected a substantial spec, got ${paths.length} paths`);
  assert.ok(schemas.length > 30, `expected a substantial spec, got ${schemas.length} schemas`);

  for (const forbidden of FORBIDDEN) {
    assert.deepEqual(
      paths.filter((p) => p.includes(forbidden)),
      [],
      `${forbidden} must not appear in the public spec's paths`,
    );
    assert.deepEqual(
      schemas.filter((s) => s.includes(forbidden)),
      [],
      `${forbidden} must not appear in the public spec's component schemas`,
    );
    // The catch-all: descriptions, examples, tags, operation ids, anything.
    assert.equal(
      rawJson.includes(forbidden),
      false,
      `${forbidden} must not appear anywhere in ${JSON_SPEC}`,
    );
    assert.equal(
      rawYaml.includes(forbidden),
      false,
      `${forbidden} must not appear anywhere in ${YAML_SPEC}`,
    );
  }
});

test("every $ref resolves — no dangling references", () => {
  // Over-pruning is the most dangerous failure mode in this pipeline: the
  // post-processor deletes component schemas that no surviving path can reach,
  // and a single missed reachability edge leaves a $ref pointing at nothing.
  // A dangling ref is that bug's signature, and most OpenAPI tooling reports it
  // as a vague parse failure rather than "we published a broken document".
  const spec = JSON.parse(read(JSON_SPEC));
  const schemas = spec.components?.schemas ?? {};
  const refs = collectRefs(spec);

  assert.ok(refs.length > 0, "expected the spec to contain $refs at all");

  const dangling = refs.filter(({ ref }) => {
    if (!ref.startsWith("#/components/schemas/")) return true; // external/unknown target
    const name = decodeURIComponent(ref.slice("#/components/schemas/".length));
    return !Object.hasOwn(schemas, name);
  });

  assert.deepEqual(
    dangling.map(({ ref, at }) => `${ref} (at ${at})`),
    [],
    "dangling $ref(s) — the component pruner dropped a schema something still points at",
  );
});

test("the spec carries the corrected licence and title", () => {
  // The raw generated document inherits shorts.proto's file-level gnostic
  // annotation, which claims `title: Shorted API` and `license: Proprietary
  // license`. The post-processor stamps the real info block over it. If that
  // silently regresses we publish a false licence claim on a public artifact.
  const spec = JSON.parse(read(JSON_SPEC));

  assert.equal(spec.info.title, "Shorted Public API");
  assert.equal(spec.info.license.name, "CC BY 4.0");
  assert.equal(spec.info.license.url, "https://creativecommons.org/licenses/by/4.0/");
  assert.equal(read(JSON_SPEC).includes("Proprietary license"), false);
  assert.equal(read(YAML_SPEC).includes("Proprietary license"), false);
});
