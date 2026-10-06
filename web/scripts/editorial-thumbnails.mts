/** Export approved blog art for cards without changing its crop or masthead. */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import matter from "gray-matter";
import sharp from "sharp";

const root = resolve(import.meta.dirname, "../..");
const blogs = resolve(root, "web/_blogs");
const args = process.argv.slice(2);
const slug = args.find((arg) => arg.startsWith("--slug="))?.slice(7);
if ((args.includes("--all") ? 1 : 0) + (slug ? 1 : 0) !== 1 || args.some((arg) => arg !== "--all" && !arg.startsWith("--slug="))) {
  throw new Error("Use --all or --slug=<blog-slug>.");
}
if (slug && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) throw new Error("Invalid blog slug.");

const files = slug ? [`${slug}.mdx`] : readdirSync(blogs).filter((name) => name.endsWith(".mdx")).sort();
let originalBytes = 0;
let thumbnailBytes = 0;
for (const file of files) {
  const path = resolve(blogs, file);
  const source = readFileSync(path, "utf8");
  const { data } = matter(source);
  const match = /^\/assets\/blog\/[a-z0-9-]+\/cover-editorial-(v\d+)\.webp$/.exec(data.coverImage ?? "");
  if (!match) throw new Error(`${file}: expected a versioned editorial WebP cover.`);
  const cover = resolve(root, `web/public${data.coverImage}`);
  const meta = await sharp(cover).metadata();
  if (meta.width !== 1600 || meta.height !== 900) throw new Error(`${file}: cover must be 1600 × 900.`);
  const thumbnailImage = `${dirname(data.coverImage)}/thumbnail-editorial-${match[1]}.webp`;
  const destination = resolve(root, `web/public${thumbnailImage}`);
  const bytes = await sharp(cover).resize(800, 450).webp({ quality: 86 }).toBuffer();
  if (existsSync(destination)) {
    if (!readFileSync(destination).equals(bytes)) throw new Error(`${file}: thumbnail differs; use a new cover version.`);
  } else {
    writeFileSync(destination, bytes, { flag: "wx" });
  }

  // Keep the original frontmatter ordering, quoting and article body intact.
  const head = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source);
  if (!head) throw new Error(`${file}: missing frontmatter.`);
  const frontmatter = head[1]!;
  const field = `thumbnailImage: "${thumbnailImage}"`;
  const next = /^thumbnailImage:.*$/m.test(frontmatter)
    ? frontmatter.replace(/^thumbnailImage:.*$/m, field)
    : frontmatter.replace(/^(coverImage:.*)$/m, `$1\n${field}`);
  if (!/^thumbnailImage:/m.test(next)) throw new Error(`${file}: missing coverImage field.`);
  const updated = source.replace(head[0], head[0].replace(frontmatter, next));
  if (updated !== source) writeFileSync(path, updated);
  originalBytes += readFileSync(cover).length;
  thumbnailBytes += bytes.length;
  console.log(`${file}: ${thumbnailImage}`);
}
console.log(`${files.length} thumbnails; ${(thumbnailBytes / 1024 / 1024).toFixed(2)} MiB vs ${(originalBytes / 1024 / 1024).toFixed(2)} MiB full covers.`);

if (args.includes("--all")) {
  const output = resolve(root, "output/article-covers");
  mkdirSync(output, { recursive: true });
  const selected = files.map((file) => {
    const { data } = matter(readFileSync(resolve(blogs, file), "utf8"));
    if (typeof data.coverImage !== "string" || typeof data.thumbnailImage !== "string" || typeof data.coverAlt !== "string") {
      throw new Error(`${file}: missing selected cover, thumbnail or alternative.`);
    }
    return {
      slug: file.replace(/\.mdx$/, ""),
      coverImage: data.coverImage,
      thumbnailImage: data.thumbnailImage,
      coverAlt: data.coverAlt,
    };
  });
  // Review sheets always follow current frontmatter, including cover revisions.
  for (const size of [160, 304]) {
    const gap = 16;
    const imageHeight = size * 9 / 16;
    const rowHeight = imageHeight + 64;
    const width = 4 * size + 5 * gap;
    const height = 60 + Math.ceil(selected.length / 4) * rowHeight;
    const composites: sharp.OverlayOptions[] = [];
    const title = size === 160 ? "Shorted — 160 × 90 thumbnail proof" : "Shorted — selected editorial cover collection";
    composites.push({ input: Buffer.from(`<svg width="${width}" height="44"><text x="16" y="30" font-family="serif" font-size="22" fill="#483932">${title}</text></svg>`), left: 0, top: 0 });
    for (let i = 0; i < selected.length; i++) {
      const entry = selected[i]!;
      const left = gap + (i % 4) * (size + gap);
      const top = 60 + Math.floor(i / 4) * rowHeight;
      const asset = size === 160 ? entry.thumbnailImage : entry.coverImage;
      composites.push({ input: await sharp(resolve(root, `web/public${asset}`)).resize(size, imageHeight).toBuffer(), left, top });
      const words = entry.slug.split("-");
      const lines: string[] = [""];
      for (const word of words) {
        const last = lines.length - 1;
        if (lines[last]!.length + word.length + 1 > (size === 160 ? 25 : 43)) lines.push(word);
        else lines[last] += `${lines[last] ? " " : ""}${word}`;
      }
      composites.push({ input: Buffer.from(`<svg width="${size}" height="52">${lines.map((line, index) => `<text x="0" y="${12 + index * 13}" font-family="monospace" font-size="${size === 160 ? 10 : 11}" fill="#483932">${line}</text>`).join("")}</svg>`), left, top: top + imageHeight + 8 });
    }
    await sharp({ create: { width, height, channels: 3, background: "#F9F8F5" } }).composite(composites).jpeg({ quality: 90 }).toFile(resolve(output, size === 160 ? "thumbnail-proof.jpg" : "review-sheet.jpg"));
  }
  const manifestPath = resolve(output, "manifest.json");
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.thumbnailWidth = 800;
    manifest.thumbnailHeight = 450;
    // Keep the selected version and its generation provenance together. Older
    // originals remain on disk; the manifest describes the live local selection.
    const assets = selected.map((post) => {
      const version = /cover-editorial-(v\d+)\.webp$/.exec(post.coverImage)![1]!;
      const basename = `${post.slug}${version === "v1" ? "" : `-${version}`}`;
      const prompt = `output/article-covers/${basename}.md`;
      const original = `output/article-covers/${basename}.png`;
      if (!existsSync(resolve(root, prompt)) || !existsSync(resolve(root, original))) {
        throw new Error(`${post.slug}: selected ${version} requires its exact prompt and original.`);
      }
      return {
        ...manifest.assets.find((entry: { slug: string }) => entry.slug === post.slug),
        slug: post.slug,
        asset: `web/public${post.coverImage}`,
        alt: post.coverAlt,
        prompt,
        original,
        thumbnail: `web/public${post.thumbnailImage}`,
      };
    });
    manifest.assets = assets;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  console.log("Refreshed selected-cover sheet, 160 × 90 proof and selected-asset provenance manifest.");
}
