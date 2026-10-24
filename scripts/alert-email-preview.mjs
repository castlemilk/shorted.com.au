#!/usr/bin/env node
// Screenshots the alert email previews written by TestAlertEmailPreview: each HTML
// file at a desktop and a phone width, in light and dark colour schemes, full page.
//
//   ALERT_EMAIL_PREVIEW_DIR=/some/dir go test -run TestAlertEmailPreview ./internal/jobs/alerts/
//   node scripts/alert-email-preview.mjs /some/dir
//
// Playwright comes from web/node_modules, so run `npm ci` in web/ first.

import { createRequire } from 'node:module';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const webRequire = createRequire(path.join(here, '..', 'web', 'package.json'));
const playwrightEntry = webRequire.resolve('playwright');
const { chromium } = webRequire('playwright');

const dir = path.resolve(process.argv[2] ?? process.env.ALERT_EMAIL_PREVIEW_DIR ?? '');
if (!dir || !existsSync(dir)) {
  console.error('usage: alert-email-preview.mjs <dir with the preview HTML files>');
  process.exit(2);
}

const designs = ['pls', 'short11', 'short14', 'glc', 'bhp', 'industry', 'canary'];
const widths = [640, 390];
const schemes = ['light', 'dark'];

const browser = await chromium.launch();
const written = [];
try {
  for (const design of designs) {
    const file = path.join(dir, `${design}.html`);
    if (!existsSync(file)) {
      throw new Error(`missing ${file}`);
    }
    for (const width of widths) {
      for (const scheme of schemes) {
        const context = await browser.newContext({
          viewport: { width, height: 1800 },
          colorScheme: scheme,
          deviceScaleFactor: 1,
        });
        const page = await context.newPage();
        await page.goto(pathToFileURL(file).href, { waitUntil: 'load' });
        await page.evaluate(() => Promise.all([...document.images].map((img) => img.complete ? null : new Promise((r) => { img.onload = img.onerror = r; }))));
        const out = path.join(dir, `${design}-${width}-${scheme}.png`);
        await page.screenshot({ path: out, fullPage: true });
        written.push(out);
        await context.close();
      }
    }
  }
} finally {
  await browser.close();
}
for (const f of written) console.log(f);
