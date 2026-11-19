// Exercise the public graph on a running Shorted instance with real market data.
// node scripts/capture-ownership-graph.mjs http://localhost:3000 /path/to/screenshots
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const [base, target] = process.argv.slice(2);
if (!base || !target)
  throw Error("Supply the site URL and screenshot directory");
await mkdir(target, { recursive: true });
const origin = new URL(base),
  browser = await chromium.launch();
try {
  const page = await browser.newPage({
    colorScheme: "light",
    reducedMotion: "reduce",
    locale: "en-AU",
    timezoneId: "Australia/Melbourne",
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.setDefaultTimeout(20000);
  page.setDefaultNavigationTimeout(90000);
  const desktop = { width: 1440, height: 960 },
    phone = { width: 390, height: 844 };
  const hub = "/ownership/traders/australia",
    graph = "/ownership/connections/explore";
  const main = page.getByRole("main").first(),
    head = (name) => main.getByRole("heading", { level: 1, name, exact: true });
  const link = (label, scope = main) =>
    scope.getByRole("link", { name: label, exact: true });
  async function open(route) {
    const r = await page.goto(new URL(route, origin).href, {
      waitUntil: "domcontentloaded",
    });
    assert.equal(r?.status(), 200, route);
  }
  async function ready() {
    await page.evaluate(() => document.fonts.ready);
    await page.waitForFunction(
      () => document.documentElement.scrollWidth <= innerWidth,
    );
    await page.evaluate(
      () =>
        new Promise((r) =>
          requestAnimationFrame(() => requestAnimationFrame(r)),
        ),
    );
  }
  async function verifyPhoto(locator) {
    await locator.evaluate(async (img) => {
      await img.decode();
      if (!img.naturalWidth) throw Error("No decoded photo");
      if (parseFloat(getComputedStyle(img).borderRadius) < 8)
        throw Error("Square portrait corners");
    });
  }
  async function save(label, view) {
    await page.setViewportSize(view);
    await ready();
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
    await page.locator("main img").evaluateAll(async (imgs) => {
      await Promise.allSettled(
        imgs
          .filter((img) => {
            const r = img.getBoundingClientRect();
            return r.top < innerHeight && r.bottom > 0;
          })
          .map((img) => img.decode()),
      );
    });
    await page.mouse.move(2, 2);
    await page.screenshot({ path: path.join(target, label + ".png") });
  }
  async function both(label) {
    await save(label + "-desktop", desktop);
    await save(label + "-mobile", phone);
  }
  await page.setViewportSize(desktop);
  await open(graph);
  await head("Ownership graph").waitFor();
  assert(
    (await main
      .getByRole("region", { name: "Browse companies" })
      .getByRole("link")
      .count()) >= 39,
  );
  const start = main.getByRole("region", { name: "Company ownership paths" });
  await verifyPhoto(
    start
      .getByRole("link", { name: "David Shafer", exact: true })
      .locator("img"),
  );
  await both("ownership-graph-index");
  await start.getByRole("link", { name: /KGN.*Kogan/ }).click();
  await head("Kogan.com").waitFor();
  await page.setViewportSize(desktop);
  await open(hub + "?issuer=KGN");
  const directory = main.getByRole("region", { name: "Investor profiles" });
  await directory
    .getByRole("heading", { name: "Investors in Kogan.com" })
    .waitFor();
  for (const name of ["Ruslan Kogan", "David Shafer", "Goran Stefkovski"])
    await verifyPhoto(link(name, directory).locator("img"));
  await link("Explore KGN ownership graph").click();
  await head("Kogan.com").waitFor();
  const paths = main.getByRole("region", { name: "Ownership paths" });
  assert.equal(
    await paths
      .getByRole("link", { name: "Shafer Corporation Pty Ltd", exact: true })
      .count(),
    1,
  );
  await paths.getByText("3,075,642 shares").waitFor();
  const shaferLink = paths.getByRole("link", { name: /^David Shafer/ });
  await verifyPhoto(shaferLink.locator("img"));
  await verifyPhoto(
    paths.getByRole("link", { name: /^Goran Stefkovski/ }).locator("img"),
  );
  await both("kogan-ownership-graph");
  await shaferLink.click();
  await head("David Shafer").waitFor();
  await link("Investor profile").click();
  await head("David Shafer").waitFor();
  await page.waitForURL("**" + hub + "/david-shafer");
  await verifyPhoto(
    main.getByRole("img", { name: "Portrait of David Shafer" }),
  );
  assert.match(
    await main
      .getByRole("link", { name: /Publisher portrait of David Shafer/ })
      .getAttribute("href"),
    /kogancorporate\.com/,
  );
  await both("david-shafer-profile");
  await link("Ownership graph").click();
  await head("David Shafer").waitFor();
  await link("Shafer Corporation Pty Ltd", paths).click();
  await head("Shafer Corporation Pty Ltd").waitFor();
  await both("shafer-holding-entity");
  const parcel = link("SHAFER CORPORATION PTY LTD <SHAFER FAMILY A/C>", paths);
  await parcel.click();
  await head("SHAFER CORPORATION PTY LTD <SHAFER FAMILY A/C>").waitFor();
  await paths.getByText("300,000 shares", { exact: true }).waitFor();
  assert.equal(
    await paths.getByText("3,075,642 shares", { exact: true }).count(),
    0,
  );
  await link("ASX:KGN ownership graph").click();
  await head("Kogan.com").waitFor();
  await link("Ownership register").click();
  await link("Explore KGN ownership graph →").click();
  await head("Kogan.com").waitFor();
  await link("Company profile").click();
  await link("Explore KGN ownership graph →").click();
  await head("Kogan.com").waitFor();
  const search = page.getByRole("searchbox", {
    name: "Search the ownership graph",
  });
  await search.fill("Does not exist full name");
  await main
    .getByRole("status")
    .filter({ hasText: "No matching company" })
    .waitFor();
  await search.press("Escape");
  await search.fill("Geoff Wilson");
  await search.press("Enter");
  await head("Geoff Wilson").waitFor();
  const manager = main.getByRole("region", { name: "Reporting institution" });
  await link("Wilson Asset Management", manager).click();
  await head("Wilson Asset Management").waitFor();
  await verifyPhoto(link("Geoff Wilson").locator("img"));
  await both("wilson-institution");
  const holdings = main.getByRole("region", {
    name: "Companies in holding notices",
  });
  const issuer = holdings.getByRole("link").first();
  const to = await issuer.getAttribute("href");
  assert(to.startsWith(graph + "/company/"));
  await issuer.click();
  await main.getByRole("heading", { level: 1 }).waitFor();
  await page.waitForURL("**" + to);
  await page.goBack({ waitUntil: "domcontentloaded" });
  await head("Wilson Asset Management").waitFor();
  assert(
    await main
      .getByRole("region", { name: "Investment products" })
      .getByRole("link")
      .count(),
  );
  await open(graph + "/company/YOW");
  const notices = main.getByRole("region", {
    name: "Substantial holding notices",
  });
  const scoped = notices.locator('a[href*="/explore/account/"]').first();
  if (await scoped.count()) {
    const name = await scoped.innerText();
    await scoped.click();
    await head(name).waitFor();
    const source = main.getByRole("region", {
      name: "Notices for this filed name",
    });
    await source
      .getByRole("link", { name: /Form 60/ })
      .first()
      .waitFor();
    await link("ASX:YOW ownership graph").click();
    await page.waitForURL("**/company/YOW");
  }
  await open(hub + "/andrew-and-nicola-forrest");
  for (const n of ["Andrew Forrest", "Nicola Forrest"])
    await verifyPhoto(main.getByRole("img", { name: "Portrait of " + n }));
  await main.getByText("36.74%", { exact: true }).first().waitFor();
  await both("forrest-group");
  await open(hub + "?issuer=HVN");
  await directory
    .getByRole("heading", { name: /Investors in Harvey Norman/ })
    .waitFor();
  for (const img of await directory.locator("img").all())
    await verifyPhoto(img);
  assert.equal(await directory.locator("img").count(), 6);
  await both("harvey-norman-investors");
  for (const width of [320, 768]) {
    await page.setViewportSize({ width, height: 844 });
    await open(graph + "/company/KGN");
    await head("Kogan.com").waitFor();
    await ready();
  }
  await page.emulateMedia({ colorScheme: "dark" });
  await page.locator("html.dark").waitFor();
  await save("kogan-ownership-graph-dark", desktop);
  assert.deepEqual(errors, []);
  console.log(
    "Passed graph navigation, portraits, joint interest, search, narrow widths and dark theme.",
  );
} finally {
  await browser.close();
}
