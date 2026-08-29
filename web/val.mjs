import { chromium } from "@playwright/test";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const b = await chromium.launch({ args: ["--disable-blink-features=AutomationControlled"] });

async function newPage(vp = { width: 1440, height: 900 }, scheme = "light") {
  const ctx = await b.newContext({ viewport: vp, userAgent: UA, colorScheme: scheme });
  await ctx.addInitScript(() => Object.defineProperty(navigator, "webdriver", { get: () => undefined }));
  const p = await ctx.newPage();
  const errors = [];
  p.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 120)); });
  p.on("pageerror", (e) => errors.push("PAGEERROR " + String(e).slice(0, 120)));
  return { ctx, p, errors };
}

// 1. Find a real suburb per state from each state explorer.
const states = ["nsw", "vic", "sa", "qld", "wa", "tas", "nt", "act"];
const targets = {};
for (const st of states) {
  const { ctx, p } = await newPage();
  try {
    const r = await p.goto(`https://shorted.com.au/housing/${st}`, { waitUntil: "load", timeout: 90000 });
    await p.waitForTimeout(3500);
    const href = await p.evaluate((s) => {
      const a = [...document.querySelectorAll(`a[href^="/housing/${s}/"]`)]
        .map((n) => n.getAttribute("href")).filter((h) => h && h.split("/").length === 4);
      return a[0] ?? null;
    }, st);
    targets[st] = { stateStatus: r.status(), href };
  } catch (e) { targets[st] = { stateStatus: "ERR", href: null, err: String(e).slice(0, 60) }; }
  await ctx.close();
}
console.log("=== state explorers + discovered suburbs");
for (const [st, v] of Object.entries(targets)) console.log(` ${st.padEnd(4)} ${String(v.stateStatus).padEnd(4)} ${v.href ?? "(no suburb link)"}`);

// 2. Validate each discovered suburb page.
console.log("\n=== suburb pages");
for (const [st, v] of Object.entries(targets)) {
  if (!v.href) continue;
  const { ctx, p, errors } = await newPage();
  try {
    const r = await p.goto("https://shorted.com.au" + v.href, { waitUntil: "load", timeout: 90000 });
    await p.waitForTimeout(6000);
    const d = await p.evaluate(() => {
      const t = document.body.innerText;
      const blackFill = [...document.querySelectorAll("path[fill^='url(']")]
        .some((n) => getComputedStyle(n).fill === "rgb(0, 0, 0)");
      return {
        h1: document.querySelector("h1")?.textContent?.trim().slice(0, 28) ?? null,
        band: /pctile/.test(t),
        priced: /median house/.test(t),
        sources: (t.match(/Sources:[^]{0,150}/) ?? [""])[0].replace(/\s+/g, " ").slice(0, 130),
        blackFill,
        overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      };
    });
    console.log(` ${st.padEnd(4)} ${r.status()} h1=${String(d.h1).padEnd(20)} band=${d.band ? "Y" : "n"} priced=${d.priced ? "Y" : "n"} blackChart=${d.blackFill ? "YES!" : "no"} ovf=${d.overflow ? "YES!" : "no"} err=${errors.length}`);
    console.log(`        ${d.sources}`);
  } catch (e) { console.log(` ${st.padEnd(4)} ERR ${String(e).slice(0, 80)}`); }
  await ctx.close();
}
await b.close();
