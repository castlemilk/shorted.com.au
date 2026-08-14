import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ARCHETYPES, STYLE } from "./banner-set.config.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_ROOT = join(HERE, "..", "..", "public", "economy-banners");
const EXPECTED_SLUGS = ["nsw", "vic", "qld", "sa", "wa", "tas", "nt", "act"];
const SACRED_SITE_TERMS = [
  "uluru",
  "kata tjuta",
  "arnhem land",
  "kakadu",
  "devils marbles",
  "kununurra",
];

test("defines one distinct landscape prompt for every economy state slug", () => {
  assert.equal(ARCHETYPES.length, 8);
  assert.deepEqual(
    [...ARCHETYPES.map(({ id }) => id)].sort(),
    [...EXPECTED_SLUGS].sort(),
  );
  assert.equal(new Set(ARCHETYPES.map(({ subject }) => subject)).size, 8);
  assert.match(STYLE.suffix, /Full-bleed landscape scene/i);
});

test("keeps generated content free of text and named sacred sites", () => {
  assert.match(STYLE.suffix, /No text, no letters, no numbers/i);
  const prompts = ARCHETYPES.map(
    ({ subject }) => `${subject}. ${STYLE.suffix}`.toLowerCase(),
  );
  for (const prompt of prompts) {
    for (const term of SACRED_SITE_TERMS) {
      assert.equal(prompt.includes(term), false, `prompt contains ${term}`);
    }
  }
});

test("publishes light and dark banner paths for every state slug", () => {
  const manifestPath = join(PUBLIC_ROOT, "manifest.json");
  assert.equal(
    existsSync(manifestPath),
    true,
    "economy banner manifest has not been baked",
  );

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  assert.deepEqual(Object.keys(manifest).sort(), [...EXPECTED_SLUGS].sort());
  for (const slug of EXPECTED_SLUGS) {
    assert.deepEqual(manifest[slug], {
      light: `/economy-banners/bg/${slug}.light.avif`,
      dark: `/economy-banners/bg/${slug}.dark.avif`,
    });
    for (const assetPath of Object.values(manifest[slug])) {
      assert.equal(
        existsSync(join(PUBLIC_ROOT, assetPath.replace("/economy-banners/", ""))),
        true,
        `missing ${assetPath}`,
      );
    }
  }
});
