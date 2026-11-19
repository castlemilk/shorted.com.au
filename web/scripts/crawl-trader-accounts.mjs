// npm run traders:crawl -- --write refreshes the server-side snapshot.
// --discover also prints public profile and photo candidates for editorial review.
import { randomUUID } from "node:crypto";
import { rename, rm, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse } from "parse5";
import robotsParser from "robots-parser";
import { publicAccounts } from "../src/server/traders/public-accounts.ts";
import { publisherPortraits } from "../src/server/traders/portraits.ts";
import { TRADERS } from "../src/@/lib/ownership/traders.ts";
import { AUSTRALIAN_INVESTORS } from "../src/@/lib/ownership/australian-investors.ts";

const agent = "ShortedProfileBot";
const headers = {
  "User-Agent": agent + "/1.0 (+https://shorted.com.au/ownership/traders)",
};
const snapshot = fileURLToPath(
  new URL("../src/server/traders/account-crawl.json", import.meta.url),
);
const hostname = (u) => u.hostname.toLowerCase().replace(/^www\./, "");
const withoutFragment = (s) => s.split("#")[0];

function webUrl(value, base) {
  try {
    const u = new URL(value, base);
    return /^https?:$/.test(u.protocol) && !u.username && !u.password && !u.port
      ? u
      : undefined;
  } catch {
    return undefined;
  }
}

// Canonical account identities for comparing an editorial URL to a publisher's
// outbound links. Share buttons, posts and generic platform homepages are excluded.
export function socialUrl(value, base) {
  const u = webUrl(value, base);
  if (!u) return;
  const host = hostname(u);
  const parts = u.pathname.split("/").filter(Boolean);
  const [first, second] = parts;
  if (!first) return;
  if (
    host === "linkedin.com" &&
    ["in", "company", "showcase"].includes(first) &&
    parts.length === 2 &&
    /^[\w%-]+$/.test(second)
  ) {
    return (
      "https://www.linkedin.com/" + first + "/" + second.toLowerCase() + "/"
    );
  }
  if (
    ["twitter.com", "x.com"].includes(host) &&
    parts.length === 1 &&
    /^[\w]{1,15}$/.test(first) &&
    !/^(home|login|logout|signup|share|intent|search|settings|explore|i|messages|notifications|tos|privacy|jobs|about|download)$/i.test(
      first,
    )
  ) {
    return "https://x.com/" + first.toLowerCase();
  }
  if (
    host === "youtube.com" &&
    /^(videos|featured|shorts|about|streams|playlists)?$/.test(parts.at(-1)) &&
    parts.length > 1
  ) {
    parts.pop();
  }
  if (host === "youtube.com" && parts.length === 1 && /^@[\w.-]+$/.test(first))
    return "https://www.youtube.com/" + first.toLowerCase();
  if (
    host === "youtube.com" &&
    parts.length === 2 &&
    first === "channel" &&
    /^UC[\w-]+$/.test(second)
  )
    return "https://www.youtube.com/channel/" + second;
  if (host === "substack.com" && parts.length === 1 && /^@[\w.-]+$/.test(first))
    return "https://substack.com/" + first.toLowerCase();
  if (
    ["facebook.com", "instagram.com"].includes(host) &&
    parts.length === 1 &&
    /^[\w.]+$/.test(first) &&
    !/^(p|reel|reels|stories|accounts|explore|share|share\.php|sharer|sharer\.php|login|login\.php|profile\.php|dialog|help|plugins|terms|privacy|tr|watch|groups|photo\.php|videos)$/i.test(
      first,
    )
  ) {
    return "https://www." + host + "/" + first.toLowerCase();
  }
}

export function extractPage(html, url) {
  const links = new Set();
  const photos = [];
  const stack = [parse(html)];
  let title = "",
    ogImage = "",
    imageAlt = "";
  while (stack.length) {
    const node = stack.pop();
    for (const child of node.childNodes ?? []) stack.push(child);
    const a = Object.fromEntries(
      (node.attrs ?? []).map(({ name, value }) => [name, value]),
    );
    if (node.tagName === "a" && a.href) {
      const account = socialUrl(a.href, url);
      if (account) links.add(account);
    }
    if (node.tagName === "title")
      title = (node.childNodes ?? [])
        .map((c) => c.value ?? "")
        .join("")
        .trim();
    if (node.tagName === "meta" && a.property === "og:image")
      ogImage = a.content;
    if (node.tagName === "meta" && a.property === "og:image:alt")
      imageAlt = a.content;
    if (node.tagName === "img" && (a["data-src"] || a.src)) {
      const src = webUrl(a["data-src"] || a.src || "", url);
      if (
        src &&
        !/logo|icon|avatar placeholder|sprite/i.test(
          (a.alt ?? "") + src.pathname,
        )
      )
        photos.push({
          label: a.alt || src.pathname.split("/").at(-1),
          url: src.href,
        });
    }
  }
  if (ogImage && imageAlt) {
    const image = webUrl(ogImage, url);
    if (image) photos.unshift({ label: imageAlt, url: image.href });
  }
  return { title, links: [...links].sort(), photos };
}

async function readBounded(response, max) {
  const chunks = [];
  let length = 0;
  for await (const chunk of response.body ?? []) {
    length += chunk.byteLength;
    if (length > max) throw new Error("Page exceeds the size limit");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export function createReader(seedUrls, request = fetch, sleep = pause) {
  const hosts = new Set(seedUrls.map((s) => hostname(new URL(s))));
  const policies = new Map(),
    lastRead = new Map();
  const permitted = (u) => u?.protocol === "https:" && hosts.has(hostname(u));
  const get = (url) =>
    request(url, {
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(9000),
    });
  async function policy(origin) {
    if (policies.has(origin)) return policies.get(origin);
    let url = new URL("/robots.txt", origin),
      result = "unavailable";
    try {
      for (let i = 0; i < 5 && permitted(url); i++) {
        const res = await get(url);
        if (res.status === 404 || res.status === 410) {
          await res.body?.cancel();
          result = null;
          break;
        }
        if (res.status >= 300 && res.status < 400) {
          const next = res.headers.get("location");
          await res.body?.cancel();
          if (!next) break;
          url = webUrl(next, url);
          continue;
        }
        if (res.ok) {
          result = robotsParser(
            origin + "/robots.txt",
            await readBounded(res, 512000),
          );
        } else {
          await res.body?.cancel();
          if ([401, 403, 429, 999].includes(res.status)) result = "restricted";
        }
        break;
      }
    } catch {
      /* record unavailability and avoid the page */
    }
    policies.set(origin, result);
    return result;
  }
  return async function read(raw) {
    let u = webUrl(raw);
    try {
      for (let i = 0; i < 6 && permitted(u); i++) {
        const rules = await policy(u.origin);
        if (typeof rules === "string") return { status: rules };
        if (rules?.isAllowed(u.href, agent) === false)
          return { status: "restricted" };
        const delay = Math.max(300, (rules?.getCrawlDelay(agent) ?? 0) * 1000);
        if (delay > 30000) return { status: "unavailable" };
        await sleep(
          Math.max(0, (lastRead.get(u.origin) ?? 0) + delay - Date.now()),
        );
        lastRead.set(u.origin, Date.now());
        const res = await get(u);
        if (res.status >= 300 && res.status < 400) {
          const destination = res.headers.get("location");
          await res.body?.cancel();
          if (!destination) return { status: "unavailable" };
          u = webUrl(destination, u);
          if (
            u &&
            /\/(authwall|login|signin|i\/flow\/login|checkpoint|challenge)(\/|$)/i.test(
              u.pathname,
            )
          )
            return { status: "restricted" };
          continue;
        }
        if (!res.ok) {
          await res.body?.cancel();
          if ([401, 403, 429, 999].includes(res.status))
            return { status: "restricted" };
          return {
            status: [404, 410].includes(res.status) ? "missing" : "unavailable",
          };
        }
        const type = res.headers.get("content-type") ?? "";
        if (!/text\/html|application\/xhtml\+xml/i.test(type)) {
          await res.body?.cancel();
          return {
            status: /application\/pdf/i.test(type) ? "document" : "unavailable",
          };
        }
        const page = extractPage(await readBounded(res, 2_000_000), u.href);
        if (
          /^(sign in|log in|login|authwall|checking your browser|just a moment|access denied|cloudflare)/i.test(
            page.title,
          )
        )
          return { status: "restricted" };
        return { status: "responded", ...page };
      }
    } catch {
      /* an unreachable page cannot substantiate a match */
    }
    return { status: "unavailable" };
  };
}

async function main() {
  const options = process.argv.slice(2);
  if (options.some((x) => !["--write", "--discover"].includes(x)))
    throw new Error("Use --write or --discover.");
  const accounts = Object.values(publicAccounts).flatMap((p) => [
    ...p.personal,
    ...(p.firm ?? []),
    ...(p.coHosted?.accounts ?? []),
  ]);
  const socials = new Map(
    accounts.map((a) => [socialUrl(a.url), a.url]).filter(([key]) => key),
  );
  const normalizeName = (s) =>
    s
      .toLowerCase()
      .replace(/[^a-z]+/g, " ")
      .trim();
  const names = [...TRADERS, ...AUSTRALIAN_INVESTORS].map((p) =>
    normalizeName(p.name).replace(/^(?:mr|mrs|ms) /, ""),
  );
  const seeds = new Set(
    accounts.flatMap((a) => [a.url, withoutFragment(a.source.url)]),
  );
  const bioUrls = Object.values(publisherPortraits).map((p) =>
    withoutFragment(p.url),
  );
  for (const url of bioUrls) seeds.add(url);
  const sources = new Set([
    ...accounts.map((a) => withoutFragment(a.source.url)),
    ...bioUrls,
  ]);
  const read = createReader([...seeds]);
  const pages = {};
  for (const url of [...seeds].sort()) {
    const { status, links = [], photos = [] } = await read(url);
    const matched = sources.has(url)
      ? links
          .filter((link) => socials.has(link))
          .map((link) => socials.get(link))
      : [];
    pages[url] = matched.length ? { status, links: matched } : { status };
    console.log(status.padEnd(12), url);
    if (options.includes("--discover") && sources.has(url)) {
      for (const candidate of links.filter((s) => !socials.has(s)))
        console.log("  Account candidate", candidate);
      for (const photo of photos.filter((p) =>
        names.some((name) => normalizeName(p.label).includes(name)),
      ))
        console.log("  Photo candidate", photo.label, photo.url);
    }
  }
  if (options.includes("--write")) {
    if (!Object.values(pages).some((p) => p.status === "responded"))
      throw new Error("No public HTML reached. Previous snapshot retained.");
    const tmp = snapshot + "." + randomUUID() + ".tmp";
    try {
      await writeFile(
        tmp,
        JSON.stringify(
          { checkedOn: new Date().toISOString().slice(0, 10), pages },
          null,
          2,
        ) + "\n",
      );
      await rename(tmp, snapshot);
    } finally {
      await rm(tmp, { force: true });
    }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main();
