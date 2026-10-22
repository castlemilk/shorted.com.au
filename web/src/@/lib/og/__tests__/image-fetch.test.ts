/**
 * @jest-environment node
 */
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { getCompanyLogo, NO_LOGO } from "../card";
import { ogImageFetchUrl } from "../image-fetch";

/**
 * OG image routes fetch a stored logo or take image from our servers, and
 * fetched whatever URL the row held, following redirects. Those rows are
 * scraped or model-written (security review SEC-07), so a bad row could point
 * our server at any address. Only https is fetched: Cloud Storage, and
 * the static files under /assets/ on our own host, where a take imported from
 * content/news keeps its art.
 */

const LOGO = "https://storage.googleapis.com/shorted-company-logos/BHP.png";

describe("ogImageFetchUrl", () => {
  it.each([
    [LOGO],
    ["https://storage.googleapis.com/shorted-news-images/takes/some-take-hero.png"],
  ])("allows %s", (url) => {
    expect(ogImageFetchUrl(url)).toBe(url);
  });

  it("allows the host in any case, and trims", () => {
    expect(ogImageFetchUrl("  https://Storage.GoogleAPIs.com/b/x.png ")).toBe(
      "https://storage.googleapis.com/b/x.png",
    );
  });

  it.each([
    ["http://storage.googleapis.com/b/x.png"],
    ["https://169.254.169.254/latest/meta-data/"],
    ["http://169.254.169.254/computeMetadata/v1/"],
    ["https://localhost/x.png"],
    ["https://127.0.0.1/x.png"],
    ["https://[::1]/x.png"],
    ["https://10.0.0.5/x.png"],
    ["https://metadata.google.internal/computeMetadata/v1/"],
    ["https://evil.example/x.png"],
    ["https://storage.googleapis.com.evil.example/x.png"],
    ["https://evil.example/storage.googleapis.com/x.png"],
    ["https://storage.googleapis.com@evil.example/x.png"],
    ["https://user:pass@storage.googleapis.com/b/x.png"],
    ["https://storage.googleapis.com:8443/b/x.png"],
    ["https://storage.googleapis.com./b/x.png"],
    ["//storage.googleapis.com/b/x.png"],
    ["javascript:alert(1)"],
    ["file:///etc/passwd"],
    [""],
    [null],
    [undefined],
  ])("refuses %p", (url) => {
    expect(ogImageFetchUrl(url)).toBeUndefined();
  });

  // The shapes content/news frontmatter uses (import-mdx.ts stores them as
  // written): absolute on our host, or root-relative, which resolves to it.
  it.each([
    [
      "https://shorted.com.au/assets/news/tlx-bipass-fast-track-and-short-baseline/cover.png",
      "https://shorted.com.au/assets/news/tlx-bipass-fast-track-and-short-baseline/cover.png",
    ],
    [
      "/assets/news/droneshield-dro-short-interest/cover.png",
      "https://shorted.com.au/assets/news/droneshield-dro-short-interest/cover.png",
    ],
    [
      " https://Shorted.com.au/assets/news/a-take/cover-editorial-v1.webp",
      "https://shorted.com.au/assets/news/a-take/cover-editorial-v1.webp",
    ],
  ])("allows our own static file %p", (url, fetched) => {
    expect(ogImageFetchUrl(url)).toBe(fetched);
  });

  it.each([
    ["https://shorted.com.au/api/internal/admin-check"],
    ["/api/internal/admin-check"],
    ["https://shorted.com.au/shorts/BHP"],
    ["https://shorted.com.au/"],
    ["https://shorted.com.au/assets"],
    ["https://shorted.com.au/assets/"],
    ["https://shorted.com.au/assets/../api/internal/admin-check"],
    ["/assets/%2e%2e/api/internal/admin-check"],
    ["https://shorted.com.au/assets/..%2fapi/internal/admin-check"],
    ["https://shorted.com.au/assets/news%2F..%2F..%2Fapi/x.png"],
    ["https://shorted.com.au/assets/.env"],
    ["https://shorted.com.au/assets//x.png"],
    ["http://shorted.com.au/assets/news/a-take/cover.png"],
    ["https://shorted.com.au:8443/assets/news/a-take/cover.png"],
    ["https://user@shorted.com.au/assets/news/a-take/cover.png"],
    ["https://shorted.com.au./assets/news/a-take/cover.png"],
    ["https://shorted.com.au.evil.example/assets/news/a-take/cover.png"],
    ["https://evil.example/assets/news/a-take/cover.png"],
    ["//shorted.com.au/assets/news/a-take/cover.png"],
    ["/\\evil.example/assets/news/a-take/cover.png"],
    ["/\t/evil.example/assets/news/a-take/cover.png"],
    ["assets/news/a-take/cover.png"],
    ["#cover"],
  ])("refuses %p on or beside our own host", (url) => {
    expect(ogImageFetchUrl(url)).toBeUndefined();
  });
});

describe("getCompanyLogo", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  // The bits of a Response getCompanyLogo reads (src/test/setup.ts swaps the
  // global Response for a stub without arrayBuffer): a 2x1 PNG header.
  const png = () =>
    ({
      ok: true,
      headers: { get: (name: string) => (name === "content-type" ? "image/png" : null) },
      arrayBuffer: async () =>
        new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 1, 0]).buffer,
    }) as unknown as Response;

  it("fetches a Cloud Storage logo, refusing redirects", async () => {
    const fetchMock = jest.spyOn(globalThis, "fetch").mockResolvedValue(png());

    const logo = await getCompanyLogo(LOGO);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe(LOGO);
    expect(fetchMock.mock.calls[0]![1]).toEqual(expect.objectContaining({ redirect: "error" }));
    expect(logo.src).toMatch(/^data:image\/png;base64,/);
  });

  it.each([
    ["http://169.254.169.254/latest/meta-data/iam/security-credentials/"],
    ["https://evil.example/logo.png"],
    ["http://storage.googleapis.com/shorted-company-logos/BHP.png"],
  ])("never fetches %s", async (url) => {
    const fetchMock = jest.spyOn(globalThis, "fetch").mockResolvedValue(png());

    const logo = await getCompanyLogo(url);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(logo).toEqual(NO_LOGO);
  });
});
