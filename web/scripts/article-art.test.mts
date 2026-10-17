import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import matter from "gray-matter";
import sharp from "sharp";
import { buildImagePrompt, imageSizeFor } from "../../scripts/image-gen/src/brand-prompt.ts";
import { scrubTopic } from "../../scripts/image-gen/src/topic-policy.ts";
import { FEATURED } from "../src/@/components/news/masthead/featured.ts";

const root = resolve(import.meta.dirname, "../..");

test("every blog has a real wide editorial cover, social preview and descriptive alternative", async () => {
  const blogs = resolve(root, "web/_blogs");
  for (const file of readdirSync(blogs).filter((name) => name.endsWith(".mdx"))) {
    const { data } = matter(readFileSync(resolve(blogs, file), "utf8"));
    assert.match(data.coverImage, /^\/assets\/blog\/.+\.(webp|png|jpg)$/i, file);
    assert.equal(data.ogImage?.url, data.coverImage, file);
    assert.ok(typeof data.coverAlt === "string" && data.coverAlt.trim().length >= 30, file);
    const metadata = await sharp(resolve(root, `web/public${data.coverImage}`)).metadata();
    assert.ok(metadata.width! >= 1200, file);
    assert.equal(metadata.width! / metadata.height!, 16 / 9, file);
    assert.equal(data.thumbnailImage, data.coverImage.replace("cover-editorial-", "thumbnail-editorial-"), file);
    const thumbnailPath = resolve(root, `web/public${data.thumbnailImage}`);
    const thumbnail = await sharp(thumbnailPath).metadata();
    assert.equal(thumbnail.width, 800, file);
    assert.equal(thumbnail.height, 450, file);
    assert.ok(readFileSync(thumbnailPath).length < readFileSync(resolve(root, `web/public${data.coverImage}`)).length, file);
  }
});

test("hero and thumbnail briefs preserve the specific idea and share a wide art direction", () => {
  const topic = "Scissors shorten an advertised sale tag beside an intact weatherboard house.";
  for (const type of ["hero", "thumbnail"] as const) {
    const prompt = buildImagePrompt({ topic, type, additionalContext: "Vendors revise asking prices, not settled values." });
    assert.ok(prompt.includes(topic));
    assert.ok(prompt.includes("Vendors revise asking prices, not settled values."));
    assert.ok(prompt.includes("16:9"));
    assert.ok(prompt.includes("conceptual editorial art"));
    assert.equal(imageSizeFor(type), "1536x1024");
    assert.doesNotMatch(prompt, /square thumbnail|Visual style: dark background|recognisable architecture/);
  }
});

test("pinned investigations point to real wide editorial thumbnails", async () => {
  for (const item of FEATURED) {
    assert.ok(item.image?.startsWith("/assets/features/"), item.href);
    const metadata = await sharp(resolve(root, `web/public${item.image}`)).metadata();
    assert.equal(metadata.width, 800, item.href);
    assert.equal(metadata.height, 450, item.href);
  }
});

test("the review manifest follows every selected cover and preserves its prompt and original", () => {
  const manifest = JSON.parse(readFileSync(resolve(root, "output/article-covers/manifest.json"), "utf8"));
  const files = readdirSync(resolve(root, "web/_blogs")).filter((name) => name.endsWith(".mdx"));
  assert.equal(manifest.assets.length, files.length);
  assert.equal(new Set(manifest.assets.map((entry: { slug: string }) => entry.slug)).size, files.length);
  for (const file of files) {
    const { data } = matter(readFileSync(resolve(root, `web/_blogs/${file}`), "utf8"));
    const slug = file.replace(/\.mdx$/, "");
    const entry = manifest.assets.find((asset: { slug: string }) => asset.slug === slug);
    assert.ok(entry, file);
    assert.equal(entry.asset, `web/public${data.coverImage}`, file);
    assert.equal(entry.thumbnail, `web/public${data.thumbnailImage}`, file);
    assert.equal(entry.alt, data.coverAlt, file);
    const version = /cover-editorial-(v\d+)\.webp$/.exec(data.coverImage)?.[1];
    assert.ok(version, file);
    const basename = `${slug}${version === "v1" ? "" : `-${version}`}`;
    assert.equal(entry.prompt, `output/article-covers/${basename}.md`, file);
    assert.equal(entry.original, `output/article-covers/${basename}.png`, file);
    assert.ok(existsSync(resolve(root, entry.prompt)), `${file}: exact prompt`);
    assert.ok(existsSync(resolve(root, entry.original)), `${file}: original`);
    const prompt = readFileSync(resolve(root, entry.prompt), "utf8");
    assert.match(prompt, /built-in.*image_gen/i, file);
  }
});

test("topic policy accepts housing and capacity mechanisms, and keeps rejected clichés tied to the article", () => {
  for (const topic of ["An hourglass bottleneck depicts covering capacity.", "An Australian weatherboard house on a paper street."]) {
    const asset = { type: "hero" as const, topic, rationale: "Specific mechanism" };
    assert.deepEqual(scrubTopic(asset), asset);
  }
  const result = scrubTopic({ type: "hero", topic: "A rocket over money stacks.", rationale: "Price momentum" }, "Uneven short-interest rotation");
  assert.ok(result.topic.includes("Uneven short-interest rotation"));
  assert.doesNotMatch(result.topic, /rocket|money stacks/);
});
