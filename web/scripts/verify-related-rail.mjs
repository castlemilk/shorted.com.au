import { chromium } from "@playwright/test";
const URL = process.env.TARGET_URL || "https://shorted.com.au/shorts/ASX";
const browser = await chromium.launch({ headless: true });
const page = await (await browser.newContext({ viewport:{width:1280,height:1700} })).newPage();
const r = { url: URL, railLoaded:false, railArticles:0, sampleHeadlines:[] };
try {
  await page.goto(URL, { waitUntil:"networkidle", timeout:60000 });
  await page.waitForTimeout(3000);
  await page.getByRole("tab", { name:"News", exact:true }).first().click();
  // Wait for the rail's loaded-state description (only present when data arrived).
  const desc = page.getByText("Semantically similar stories across outlets", { exact:false }).first();
  await desc.waitFor({ state:"visible", timeout:30000 }).catch(()=>{});
  r.railLoaded = (await desc.count()) > 0;
  // Headlines inside the Related coverage card.
  const railCard = page.locator("div").filter({ has: page.getByText("Semantically similar stories across outlets") }).last();
  r.sampleHeadlines = (await railCard.locator("a[target=_blank] h4").allInnerTexts().catch(()=>[])).slice(0,5);
  r.railArticles = r.sampleHeadlines.length;
  await page.waitForTimeout(1500);
  await page.screenshot({ path:"/tmp/related-rail.png", fullPage:true });
} catch(e){ r.error = String(e).slice(0,200); }
finally { await browser.close(); }
console.log(JSON.stringify(r));
