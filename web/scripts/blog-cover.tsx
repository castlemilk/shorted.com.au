/**
 * Render a branded cover for a blog post — the same scene canvas the housing
 * Open Graph cards use — to web/public/assets/blog/<slug>/cover.png.
 *
 *   npx tsx scripts/blog-cover.tsx <slug> [scene]
 *
 * Reads the post's frontmatter title from web/_blogs/<slug>.mdx. `scene` is one
 * of the committed housing-banners/og archetypes (default leafy-suburban) or
 * "none" for the plain dark canvas used by the ASX posts. Runs `next/og`
 * outside Next, which is why this lives in web/scripts (it must resolve
 * `next` from web/node_modules).
 */
import React from "react";
import { ImageResponse } from "next/og";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const OG = { bg: "#0a0a0a", bgAlt: "#141414", text: "#fafafa", textDim: "#a1a1aa", orange: "#FFA94D", orangeDim: "#d4a017", border: "#27272a" };

function frontmatter(slug: string): { title: string; excerpt: string } {
  const raw = readFileSync(join(process.cwd(), "_blogs", `${slug}.mdx`), "utf8");
  const block = /^---\n([\s\S]*?)\n---/.exec(raw)?.[1] ?? "";
  const get = (k: string) => new RegExp(`^${k}:\\s*"?(.*?)"?\\s*$`, "m").exec(block)?.[1] ?? "";
  return { title: get("title"), excerpt: get("excerpt") };
}

async function main() {
  const [slug, scene = "leafy-suburban"] = process.argv.slice(2);
  if (!slug) throw new Error("usage: blog-cover.tsx <slug> [scene|none]");
  const { title } = frontmatter(slug);
  let sceneSrc = "";
  if (scene !== "none") {
    const p = join(process.cwd(), "public", "housing-banners", "og", `${scene}.jpg`);
    sceneSrc = `data:image/jpeg;base64,${readFileSync(p).toString("base64")}`;
  }
  const logo = `data:image/png;base64,${readFileSync(join(process.cwd(), "public", "icon-512.png")).toString("base64")}`;
  const eyebrow = scene === "none" ? "ASX short selling" : "Australian house prices";

  const res = new ImageResponse(
    (
      <div style={{ height: "100%", width: "100%", display: "flex", flexDirection: "column", position: "relative", backgroundColor: OG.bg, backgroundImage: `linear-gradient(135deg, ${OG.bg} 0%, ${OG.bgAlt} 55%, ${OG.bg} 100%)` }}>
        {sceneSrc ? <img src={sceneSrc} width={1200} height={630} style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "100%", objectFit: "cover" }} /> : null}
        {sceneSrc ? <div style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "100%", display: "flex", backgroundColor: "rgba(10,10,10,0.66)" }} /> : null}
        <div style={{ display: "flex", position: "absolute", top: 0, left: 0, right: 0, height: 8, backgroundImage: `linear-gradient(90deg, ${OG.orange} 0%, ${OG.orangeDim} 100%)` }} />
        <div style={{ display: "flex", flexDirection: "column", flex: 1, padding: "60px 64px 0 64px", position: "relative" }}>
          <div style={{ display: "flex", fontSize: 22, letterSpacing: 3, textTransform: "uppercase", color: OG.orange, fontWeight: 600 }}>{eyebrow}</div>
          <div style={{ display: "flex", marginTop: 22, fontSize: title.length > 70 ? 50 : title.length > 45 ? 58 : 70, lineHeight: 1.08, fontFamily: "Georgia, 'Times New Roman', serif", color: OG.text, fontWeight: 700, maxWidth: 1040 }}>{title}</div>
        </div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", borderTop: `1px solid ${OG.border}`, margin: "0 64px", padding: "22px 0 32px 0", position: "relative" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <img src={logo} width={48} height={48} style={{ borderRadius: 8 }} />
            <div style={{ display: "flex", fontSize: 26, fontWeight: 700, color: OG.text }}>Shorted</div>
          </div>
          <div style={{ display: "flex", fontSize: 22, color: OG.textDim }}>shorted.com.au/blog</div>
        </div>
      </div>
    ),
    { width: 1200, height: 630 },
  );
  const buf = Buffer.from(await res.arrayBuffer());
  const dir = join(process.cwd(), "public", "assets", "blog", slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "cover.png"), buf);
  console.log(`wrote ${join(dir, "cover.png")} (${buf.length} bytes)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
