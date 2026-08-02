// Politics iconography — the review contact sheet.
//
// Renders EVERY icon from the PACKED SPRITE (not from out/), using the same
// background-position slicing maths <PoliticsIcon> uses, into one labelled page
// and screenshots it. So it is two things at once:
//
//   1. the review artefact — one screen on which banned imagery (money, a
//      warning mark, a gavel, scales, a trophy) is obvious at a glance, and
//   2. a PROOF THE SPRITE SLICES CORRECTLY. If a coord in the generated manifest
//      is wrong, this sheet shows a half-icon; a jest snapshot of the numbers
//      never would.
//
// Usage:
//   node web/scripts/politics-icons/contact-sheet.mjs [outfile.png]
//
// Needs a Playwright browser. Falls back to writing just the HTML (and saying
// so) if one is not installed, so the sheet can still be opened by hand.
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ICONS } from "./icon-set.config.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = join(HERE, "..", "..");
const SPRITE = join(WEB, "public", "politics-icons", "politics-icons.png");

const OUT_PNG = resolve(
  process.argv[2] ||
    "/Volumes/gamma-systems-2/dev-caches/politician-briefs/politics-icons-contact-sheet.png",
);
mkdirSync(dirname(OUT_PNG), { recursive: true });
const HTML_PATH = join(HERE, "out", "contact-sheet.html");
mkdirSync(dirname(HTML_PATH), { recursive: true });

// Read the packed manifest's numbers straight from the generated module so the
// sheet cannot drift from what ships.
const manifestPath = join(WEB, "src", "@", "components", "politicians", "politics-icons.generated.ts");
const manifestSrc = await import("node:fs").then((fs) => fs.readFileSync(manifestPath, "utf8"));
const CELL = Number(/cell:\s*(\d+)/.exec(manifestSrc)?.[1] ?? 128);
const WIDTH = Number(/width:\s*(\d+)/.exec(manifestSrc)?.[1] ?? 768);
const HEIGHT = Number(/height:\s*(\d+)/.exec(manifestSrc)?.[1] ?? 768);
const coords = {};
for (const m of manifestSrc.matchAll(/"([a-z0-9-]+)":\s*\{\s*x:\s*(\d+),\s*y:\s*(\d+)\s*\}/g)) {
  coords[m[1]] = { x: Number(m[2]), y: Number(m[3]) };
}

const SIZE = 72; // rendered px per icon on the sheet
const scale = SIZE / CELL;
const spriteUrl = pathToFileURL(SPRITE).href;

const byGroup = ICONS.reduce((acc, ic) => {
  (acc[ic.group] ??= []).push(ic);
  return acc;
}, {});

const cells = Object.entries(byGroup)
  .map(
    ([group, list]) => `
  <section>
    <h2>${group}</h2>
    <div class="grid">
      ${list
        .map((ic) => {
          const pos = coords[ic.id];
          if (!pos) return `<figure class="miss"><div class="icon"></div><figcaption>${ic.id}<br><em>MISSING</em></figcaption></figure>`;
          return `<figure>
        <div class="icon" style="background-position:-${pos.x * scale}px -${pos.y * scale}px"></div>
        <figcaption><b>${ic.id}</b><br><span>${ic.subject}</span></figcaption>
      </figure>`;
        })
        .join("\n      ")}
    </div>
  </section>`,
  )
  .join("\n");

const html = `<!doctype html><meta charset="utf-8"><title>politics icons</title>
<style>
  body { margin: 0; padding: 28px; background: #fdfbf6; color: #2b2620;
         font: 13px/1.4 ui-sans-serif, system-ui, -apple-system, sans-serif; width: 1180px; }
  h1 { font: 600 20px/1.2 Georgia, serif; margin: 0 0 4px; }
  p.note { margin: 0 0 20px; color: #6b635a; }
  h2 { font: 600 12px/1 ui-monospace, monospace; text-transform: uppercase;
       letter-spacing: .08em; color: #8a8578; margin: 22px 0 10px;
       border-top: 1px solid #e6ded1; padding-top: 10px; }
  .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; }
  figure { margin: 0; display: flex; gap: 10px; align-items: flex-start;
           background: #fff; border: 1px solid #eee5d8; border-radius: 8px; padding: 10px; }
  figure.miss { background: #fff4f4; border-color: #e8c9c9; }
  .icon { width: ${SIZE}px; height: ${SIZE}px; flex: 0 0 ${SIZE}px;
          background-image: url("${spriteUrl}"); background-repeat: no-repeat;
          background-size: ${WIDTH * scale}px ${HEIGHT * scale}px; }
  figcaption { font-size: 11px; color: #4a443c; }
  figcaption b { font: 600 12px/1.3 ui-monospace, monospace; }
  figcaption span { color: #7a7268; }
</style>
<h1>Politics iconography — contact sheet</h1>
<p class="note">Sliced from the packed sprite with the same maths &lt;PoliticsIcon&gt; uses.
Review against the bans in icon-set.config.mjs: no money, no warning mark, no gavel or scales, no trophy.</p>
${cells}
`;
writeFileSync(HTML_PATH, html);

let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch {
  try {
    ({ chromium } = await import("@playwright/test"));
  } catch {
    console.error(`No Playwright available. HTML written to ${HTML_PATH} — open it by hand.`);
    process.exit(0);
  }
}
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1180, height: 900 }, deviceScaleFactor: 2 });
await page.goto(pathToFileURL(HTML_PATH).href);
await page.screenshot({ path: OUT_PNG, fullPage: true });
await browser.close();
console.error(`contact sheet -> ${OUT_PNG}`);
