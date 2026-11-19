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
  page.setDefaultNavigationTimeout(90_000);
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
  async function verifyPortrait(name) {
    const image = page.getByRole("img", { name: "Portrait of " + name });
    await image.evaluate(async (el) => {
      await el.decode();
    });
    assert(
      await image.evaluate((el) => {
        const css = getComputedStyle(el);
        const corners = [
          css.borderTopLeftRadius,
          css.borderTopRightRadius,
          css.borderBottomLeftRadius,
          css.borderBottomRightRadius,
        ];
        return (
          el.naturalWidth > 0 &&
          corners.every((radius) => Number.parseFloat(radius) >= 8)
        );
      }),
      "Portrait failed to load with four rounded corners",
    );
    const credit = page.locator("#portrait-credit");
    assert.match(
      await credit
        .getByRole("link", { name: "Original photograph" })
        .getAttribute("href"),
      /^https:\/\/commons\.wikimedia\.org\/wiki\/File:/,
    );
    const person = await page
      .locator('script[type="application/ld+json"]')
      .evaluateAll(
        (scripts) =>
          scripts
            .map((el) => JSON.parse(el.textContent))
            .find((data) => data["@type"] === "ProfilePage")?.mainEntity,
      );
    assert.equal(person.name, name);
    assert(person.image.contentUrl.endsWith(await image.getAttribute("src")));
  }
  async function verifyAccountRows(accounts) {
    const groups = accounts.getByRole("list", { name: /^Public links for / });
    assert((await groups.count()) > 0, "Missing named account lists");
    for (const group of await groups.all()) {
      const rows = await group.getByRole("link").evaluateAll((links) =>
        links.map((link) => {
          const rect = link.getBoundingClientRect();
          return {
            top: rect.top,
            bottom: rect.bottom,
            height: rect.height,
            right: rect.right,
            left: rect.left,
            fits: link.scrollWidth <= link.clientWidth + 1,
            label: link.innerText,
            icon: !!link.querySelector('svg[aria-hidden="true"]'),
          };
        }),
      );
      for (const [i, row] of rows.entries()) {
        assert(
          row.fits &&
            row.left >= 0 &&
            row.right <= page.viewportSize().width + 1 &&
            row.height >= 44,
          "Clipped account row: " + row.label,
        );
        assert(row.icon && row.label.trim(), "Missing account mark or name");
        if (i)
          assert(row.top >= rows[i - 1].bottom - 1, "Two accounts share a row");
      }
    }
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
        name: "Following " + name,
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
  await page.setViewportSize(mobile);
  await ranks
    .getByRole("link", { name: /Christopher Herbert Brown/i })
    .first()
    .click();
  await page
    .getByRole("heading", { level: 1, name: /Christopher Herbert Brown/i })
    .waitFor();
  const annualReport = page
    .getByRole("table", { name: /Registered accounts/ })
    .getByRole("link", { name: /Annual report/ })
    .first();
  await annualReport.waitFor();
  const annualBox = await annualReport.boundingBox();
  assert(
    annualBox &&
      annualBox.height >= 40 &&
      annualBox.y + annualBox.height <= mobile.height,
    "First annual filing and its page citation must fit on the phone",
  );
  await shoot("annual-investor-mobile.png");
  await page.setViewportSize(desktop);
  await go(hub + "/gina-rinehart");
  const interests = region("Disclosed voting interests");
  await interests.getByRole("link", { name: /WCN · / }).waitFor();
  await interests.getByRole("link", { name: /BM1 · / }).waitFor();
  await region("Filing history")
    .getByRole("link", { name: /Form 60/ })
    .first()
    .waitFor();
  await verifyPortrait("Gina Rinehart");
  const following = button("Following Gina Rinehart");
  if (await following.count()) await following.click();
  await shoot("investor-profile-desktop.png");
  await page.setViewportSize(mobile);
  await shoot("investor-profile-mobile.png");
  const firstNotice = interests
    .getByRole("link", { name: /^Form .*WCN filing/ })
    .first();
  const firstBox = await firstNotice.boundingBox();
  assert(
    firstBox && firstBox.y + firstBox.height <= mobile.height,
    "First ASX notice below phone viewport",
  );
  await page
    .getByRole("link", { name: "Accounts and sources", exact: true })
    .click();
  assert.equal(new URL(page.url()).hash, "#public-accounts");
  await page.locator("#public-accounts summary").focus();
  await page.keyboard.press("Enter");
  assert(
    await page.locator("#public-accounts details").evaluate((el) => el.open),
  );
  await page.setViewportSize(desktop);
  await go("/ownership/traders");
  await page
    .getByRole("link", { name: /Brad Gerstner/ })
    .first()
    .click();
  await verifyPortrait("Brad Gerstner");
  const positions = page
    .getByRole("table", { name: /Altimeter .*positions reported/i })
    .first();
  await positions.waitFor();
  if ((await positions.locator("caption").innerText()).includes("2026-09-30")) {
    const cerebras = positions
      .getByRole("row")
      .filter({ hasText: "CEREBRAS SYSTEMS INC" });
    assert.equal(await cerebras.count(), 1);
    assert.match(await cerebras.innerText(), /-1,271,533/);
    assert.equal(await positions.locator("tbody tr").count(), 17);
    const priorOnly = page
      .locator("summary")
      .filter({ hasText: "Only in the previous filing (6)" });
    await priorOnly.focus();
    await page.keyboard.press("Enter");
    const oldRows = page.getByRole("table", {
      name: /Positions reported only in the previous filing/,
    });
    assert.equal(await oldRows.locator("tbody tr").count(), 6);
    await page.keyboard.press("Enter");
    await priorOnly.blur();
  }
  console.log(
    await positions.locator("caption").innerText(),
    await positions.locator("tbody tr").count(),
    "position rows",
  );
  assert.match(
    await page
      .getByRole("link", { name: /13F-HR filed/ })
      .first()
      .getAttribute("href"),
    /^https:\/\/www\.sec\.gov\//,
  );
  await verifyAccountRows(region("Public accounts"));
  await shoot("manager-profile-desktop.png");
  await shoot("quarter-comparison-desktop.png", region("Quarterly holdings"));
  await page.setViewportSize(mobile);
  for (const width of [320, 360, mobile.width]) {
    await page.setViewportSize({ width, height: mobile.height });
    const cells = positions.locator("tbody tr").first().getByRole("cell");
    const count = await cells.count();
    assert(count >= 3, "Expected security, quantity and value");
    for (const cell of await cells.all()) {
      const box = await cell.boundingBox();
      assert(
        box && box.x >= 0 && box.x + box.width <= width,
        "US holding cell clipped at " + width,
      );
    }
  }
  await page.setViewportSize(mobile);
  await shoot("manager-profile-mobile.png");
  const firstValue = await positions
    .locator("tbody tr")
    .first()
    .getByRole("cell")
    .last()
    .boundingBox();
  assert(
    firstValue && firstValue.y + firstValue.height <= mobile.height,
    "First US position value below phone viewport",
  );
  await go("/ownership/traders");
  await page
    .getByRole("link", { name: /Michael Burry/ })
    .first()
    .click();
  const scion = page
    .getByRole("table", { name: /Scion .*positions reported/i })
    .first();
  await scion.waitFor();
  if ((await scion.locator("caption").innerText()).includes("2025-09-30")) {
    const palantir = scion
      .getByRole("row")
      .filter({ hasText: "PALANTIR TECHNOLOGIES INC" });
    assert.match(
      await palantir.getByRole("cell").last().innerText(),
      /912,100,000\s+Underlying share value/,
    );
  }
  await shoot("scion-holdings-mobile.png");
  await go(hub + "/wesley-and-emma-maas");
  await page.getByRole("heading", { name: "Wesley and Emma Maas" }).waitFor();
  assert.equal(
    await page.getByRole("img", { name: /^Portrait of/ }).count(),
    0,
  );
  await page.setViewportSize(mobile);
  await go("/ownership/traders/geoff-wilson");
  await page
    .getByRole("link", {
      name: "Publisher portrait of Geoff Wilson at Wilson Asset Management",
    })
    .waitFor();
  await page
    .getByRole("table", { name: /Voting interests attributed/ })
    .getByRole("link", { name: /notice on ASX/ })
    .first()
    .waitFor();
  await shoot("geoff-wilson-mobile.png");
  await page.setViewportSize(desktop);
  await shoot("geoff-wilson-desktop.png");
  await page.setViewportSize(mobile);
  const accounts = region("Public accounts");
  for (const owner of ["Geoff Wilson", "Wilson Asset Management"]) {
    const href = await accounts
      .getByRole("link", { name: "LinkedIn · " + owner, exact: true })
      .getAttribute("href");
    assert.match(href, /^https:\/\/www\.linkedin\.com\//);
  }
  for (const width of [320, 390, 768, 1024]) {
    await page.setViewportSize({ width, height: mobile.height });
    await verifyAccountRows(accounts);
  }
  await page.setViewportSize(mobile);
  await page.getByRole("link", { name: "Accounts and sources" }).focus();
  await page.keyboard.press("Enter");
  assert.equal(
    await accounts.evaluate((el) => el === document.activeElement),
    true,
  );
  await accounts.blur();
  await page.mouse.move(2, 2);
  await shoot("social-accounts-mobile.png", accounts);
  await page.emulateMedia({ colorScheme: "dark" });
  await page.locator("html.dark").waitFor();
  await shoot("social-accounts-mobile-dark.png", accounts);
  await page.emulateMedia({ colorScheme: "light" });
  await page.locator("html.light").waitFor();
  await accounts.locator("summary").click();
  await accounts.getByText(/Checked/).waitFor();
  const evidence = await accounts
    .locator("details a")
    .evaluateAll((links) => links.map((a) => a.href));
  assert(evidence.length > 0 && new Set(evidence).size === evidence.length);
  const stakes = page.getByRole("table", {
    name: /Voting interests attributed/,
  });
  for (const width of [320, 360, mobile.width]) {
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
  const recentNotice = page.getByRole("table", {
    name: /ASX notices associated/,
  });
  for (const width of [320, 390, 640, 768, 1024, 1280]) {
    await page.setViewportSize({ width, height: mobile.height });
    const frame = await recentNotice.evaluate(
      (el) => el.parentElement.getBoundingClientRect().right,
    );
    for (const source of await recentNotice
      .getByRole("link", { name: /Notice for .+ on ASX/ })
      .all()) {
      const doc = await source.boundingBox();
      assert(
        doc && doc.x + doc.width <= Math.min(frame, width) + 1,
        "ASX source clipped at " + width,
      );
    }
    if (width === 1024) {
      await shoot("manager-notices-tablet.png", page.locator("#recent-holder-notices"));
    }
  }
  await page.setViewportSize(mobile);
  const showNotices = page.getByRole("button", {
    name: /^Show (all|the latest).*notices/,
  });
  if (await showNotices.count()) {
    const show = await showNotices.boundingBox();
    const history = await page
      .getByRole("link", { name: /Explore the firm’s notice history/ })
      .boundingBox();
    assert(
      show && history && history.y >= show.y + show.height,
      "History link overlaps notice expansion",
    );
  }
  await shoot("trader-account-sources-mobile.png", accounts);
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
