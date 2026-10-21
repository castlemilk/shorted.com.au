// Rasterise an HTML wrapper to PNG at an exact viewport. Uses the take-writer
// playwright-core install and the session's pre-installed Chromium.
//   node scripts/news-covers/render.mjs <file.html> <out.png> [width] [height]
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
const require = createRequire(new URL("../take-writer/package.json", import.meta.url));
const { chromium } = require("playwright-core");
const [html, out, w = "1600", h = "900"] = process.argv.slice(2);
const exe = process.env.CHROME_PATH || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const browser = await chromium.launch({ executablePath: exe, args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: Number(w), height: Number(h) }, deviceScaleFactor: 1 });
await page.goto(pathToFileURL(html).href);
await page.evaluate(() => document.fonts.ready);
await page.screenshot({ path: out, clip: { x: 0, y: 0, width: Number(w), height: Number(h) } });
await browser.close();
