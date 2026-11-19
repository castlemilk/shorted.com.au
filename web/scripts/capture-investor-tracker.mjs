// Run against a Shorted production build connected to the public market service.
// node scripts/capture-investor-tracker.mjs http://localhost:3000 /path/to/screenshots
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const [base, target] = process.argv.slice(2);
if (!base || !target)
  throw new Error("Provide a base URL and a screenshot directory.");
const origin = new URL(base);
const hub = "/ownership/traders/australia";
const output = path.resolve(target);
await mkdir(output, { recursive: true });
const browser = await chromium.launch();
try {
  const desktop = { width: 1440, height: 960 };
  const mobile = { width: 390, height: 844 };
  const page = await browser.newPage({
    viewport: desktop,
    colorScheme: "light",
    reducedMotion: "reduce",
    locale: "en-AU",
    timezoneId: "Australia/Melbourne",
  });
  page.setDefaultTimeout(30_000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const button = (name) => page.getByRole("button", { name, exact: true });
  const region = (name) => page.getByRole("region", { name, exact: true });
  async function go(route) {
    const response = await page.goto(new URL(route, origin).href, {
      waitUntil: "domcontentloaded",
    });
    assert.equal(response?.status(), 200, route);
  }
  async function shoot(filename, section) {
    await page.evaluate(async () => {
      await document.fonts.ready;
    });
    await page.waitForFunction(() => {
      const tab = document.querySelector(
        'nav[aria-label="Ownership"] a[aria-current]',
      );
      const list = tab?.closest("ul");
      if (!tab || !list) return false;
      const bounds = tab.getBoundingClientRect();
      const viewport = list.getBoundingClientRect();
      return (
        bounds.left >= viewport.left - 1 && bounds.right <= viewport.right + 1
      );
    });
    if (section) {
      // Allow for both persistent navigation bars above a scrolled result.
      await section.evaluate((el) => {
        const nav = document.querySelector('nav[aria-label="Ownership"]');
        const inset = Math.max(
          120,
          (nav?.getBoundingClientRect().bottom ?? 0) + 12,
        );
        window.scrollTo({
          top: scrollY + el.getBoundingClientRect().top - inset,
          behavior: "instant",
        });
      });
    } else
      await page.evaluate(() =>
        window.scrollTo({ top: 0, behavior: "instant" }),
      );
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      filename + " overflows",
    );
    await page.screenshot({
      path: path.join(output, filename),
      animations: "disabled",
    });
  }
  await go(hub + "?view=filings");
  await page.getByRole("table", { name: /Latest releases/ }).waitFor();
  const coverage = await page
    .getByText(/notices read · Data through/)
    .innerText();
  assert.match(coverage, /\b([1-9]\d*) of \1 notices read.*\d{4}-\d{2}-\d{2}/);
  console.log(coverage);
  await page.emulateMedia({ colorScheme: "dark" });
  await page.locator("html.dark").waitFor();
  await shoot("recent-filings-dark-desktop.png");
  await page.emulateMedia({ colorScheme: "light" });
  await page.locator("html.light").waitFor();

  await button("Investors").click();
  const people = region("Investor profiles");
  await people
    .getByRole("link", { name: "Gina Rinehart", exact: true })
    .waitFor();
  assert((await people.getByRole("link", { name: /^Form \d+$/ }).count()) > 0);
  await shoot("investor-directory-desktop.png");
  await page.setViewportSize(mobile);
  await shoot("investor-directory-mobile.png");
  await page.setViewportSize(desktop);
  // Select public filers in an empty browser using the normal product controls.
  for (const name of [
    "Gina Rinehart",
    "Gerry Harvey",
    "Wesley and Emma Maas",
  ]) {
    await button("Follow " + name).click();
    await page
      .getByRole("button", {
        name: "Follow " + name,
        exact: true,
        pressed: true,
      })
      .waitFor();
  }
  await button("Following (3)").click();
  const inbox = page.getByRole("table", { name: /Filings from followed/ });
  await inbox.getByRole("link", { name: "WCN", exact: true }).first().waitFor();
  await region("Following")
    .getByText(/\b([1-9]\d*) of \1 issuer registers? loaded/)
    .waitFor();
  assert.match(
    await inbox
      .getByRole("link", { name: /^Form 60/ })
      .first()
      .getAttribute("href"),
    /^https:\/\//,
  );
  console.log(await region("Following").getByRole("status").innerText());
  await inbox
    .getByRole("button", { name: /^Read filing from/ })
    .first()
    .click();
  await inbox
    .getByRole("button", { name: /^Read filing from/, pressed: true })
    .first()
    .waitFor();
  await shoot("followed-filings-desktop.png");
  await page.setViewportSize(mobile);
  await shoot("followed-filings-mobile.png", region("Following"));
  await go(hub + "?view=ranks&sort=stake");
  const ranks = page.getByRole("table", { name: /Registered accounts/ });
  await ranks
    .getByRole("link", { name: "RealWise Holdings Pty Limited", exact: true })
    .first()
    .waitFor();
  assert.match(
    await ranks
      .getByRole("link", { name: /Annual report/ })
      .first()
      .getAttribute("href"),
    /#page=/,
  );
  const report = ranks.getByRole("link", { name: /Annual report/ }).first();
  for (const width of [360, 390, 768, 1024]) {
    await page.setViewportSize({ width, height: 844 });
    const box = await report.boundingBox();
    assert(
      box && box.x >= 0 && box.x + box.width <= width,
      "Register source outside the viewport at " + width,
    );
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
  }
  await page.setViewportSize(mobile);
  const filters = page.getByRole("button", { name: /^Filters/ });
  await filters.focus();
  await page.keyboard.press("Enter");
  assert.equal(await filters.getAttribute("aria-expanded"), "true");
  const order = page.getByRole("combobox", { name: "Order by" });
  await order.selectOption("rank");
  await order.selectOption("stake");
  assert.equal(new URL(page.url()).searchParams.get("sort"), "stake");
  await filters.focus();
  await page.keyboard.press("Space");
  assert.equal(await filters.getAttribute("aria-expanded"), "false");
  await filters.blur();
  await shoot("annual-register-mobile.png", region("Annual shareholder ranks"));
  await page.setViewportSize(desktop);
  await shoot("annual-register-desktop.png");
  await go(hub + "/gina-rinehart");
  const interests = region("Disclosed voting interests");
  await interests.getByRole("link", { name: /WCN · / }).waitFor();
  await interests.getByRole("link", { name: /BM1 · / }).waitFor();
  await region("Filing history")
    .getByRole("link", { name: /Form 60/ })
    .first()
    .waitFor();
  await shoot("investor-profile-desktop.png");
  await page.setViewportSize(mobile);
  await go("/ownership/traders/geoff-wilson");
  const accounts = region("Public accounts");
  for (const owner of ["Geoff Wilson", "Wilson Asset Management"]) {
    const href = await accounts
      .getByRole("link", { name: "LinkedIn · " + owner, exact: true })
      .getAttribute("href");
    assert.match(href, /^https:\/\/www\.linkedin\.com\//);
  }
  await accounts.locator("summary").click();
  await accounts.getByText(/Checked/).waitFor();
  const evidence = await accounts
    .locator("details a")
    .evaluateAll((links) => links.map((a) => a.href));
  assert(evidence.length > 0 && new Set(evidence).size === evidence.length);
  const stakes = page.getByRole("table", {
    name: /Voting interests attributed/,
  });
  for (const width of [360, mobile.width]) {
    await page.setViewportSize({ width, height: mobile.height });
    const source = await stakes
      .getByRole("link", { name: /notice on ASX/ })
      .first()
      .boundingBox();
    const frame = await stakes.evaluate(
      (el) => el.parentElement.getBoundingClientRect().right,
    );
    assert(
      source &&
        source.x >= 0 &&
        source.x + source.width <= Math.min(width, frame) + 1,
      "Manager holding source is clipped at " + width,
    );
  }
  await shoot("trader-account-sources-mobile.png", accounts);
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
