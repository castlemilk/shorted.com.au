/// <reference types="jest" />
import { describe, expect, it } from "@jest/globals";
import { safeExternalHref, safeLinkHref } from "~/@/lib/safe-external-href";

/**
 * Security review SEC-07: stored and scraped URLs (company websites and
 * social links, news, announcement, listing and register links, citations)
 * were rendered as hrefs as they came, and a `javascript:` href runs in our
 * origin when it is followed.
 */

const NUL = String.fromCharCode(0);
const SOH = String.fromCharCode(1);
const NBSP = String.fromCharCode(0xa0);

/** Every way the review and the browser's URL parser give to hide a scheme. */
const PAYLOADS: Array<[string, string]> = [
  ["javascript:", "javascript:alert(document.domain)"],
  ["javascript: in capitals", "JaVaScRiPt:alert(1)"],
  ["javascript: after a space", " javascript:alert(1)"],
  ["javascript: after a tab and a newline", "\t\njavascript:alert(1)"],
  ["javascript: after a no-break space", `${NBSP}javascript:alert(1)`],
  ["javascript: after a NUL", `${NUL}javascript:alert(1)`],
  ["javascript: after a control character", `${SOH}javascript:alert(1)`],
  ["javascript: split by a tab", "java\tscript:alert(1)"],
  ["javascript: split by a newline", "java\nscript:alert(1)"],
  ["javascript: dressed as a URL", "javascript://example.com/%0Aalert(1)"],
  ["data:", "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg=="],
  ["data: after a space", "  data:text/html,<script>alert(1)</script>"],
  ["vbscript:", "vbscript:msgbox(1)"],
  ["vbscript: after a space", " VBScript:msgbox(1)"],
  ["protocol-relative", "//evil.example/phish"],
  ["protocol-relative after a space", "  //evil.example/phish"],
  ["protocol-relative with backslashes", "\\\\evil.example/phish"],
  ["file:", "file:///etc/passwd"],
  ["blob:", "blob:https://example.com/0f2b"],
  ["mailto:", "mailto:someone@example.com"],
  ["ftp:", "ftp://example.com/file"],
  ["http with no host", "https://"],
  ["http with a space in the host", "https://exa mple.com"],
  ["no scheme", "www.bhp.com"],
  ["a relative path", "/shorts/BHP"],
  ["an http scheme behind a control character", `${SOH}https://example.com`],
];

describe("safeExternalHref", () => {
  it.each(PAYLOADS)("refuses %s", (_label, payload) => {
    expect(safeExternalHref(payload)).toBeUndefined();
  });

  it.each([
    ["https://www.bhp.com"],
    ["http://example.com"],
    ["https://www.asx.com.au/asxpdf/20261021/pdf/06abc123.pdf"],
    ["https://example.com/a/b?c=1&d=two#e"],
    ["HTTPS://WWW.EXAMPLE.COM/PATH"],
    ["https://user@example.com:8443/x"],
  ])("passes %s through unchanged", (url) => {
    expect(safeExternalHref(url)).toBe(url);
  });

  it("trims the whitespace a browser ignores around an http(s) URL", () => {
    expect(safeExternalHref("  https://www.bhp.com/about \n")).toBe("https://www.bhp.com/about");
    expect(safeExternalHref("\thttp://example.com")).toBe("http://example.com");
  });

  it.each([[undefined], [null], [""], ["   "], [42], [{ href: "https://example.com" }]])(
    "refuses %p",
    (value) => {
      expect(safeExternalHref(value)).toBeUndefined();
    },
  );

  it("refuses everything a browser would resolve to another scheme", () => {
    // What the browser makes of each refused payload on one of our pages: a
    // payload that resolves to http(s) here is only a relative link or a
    // malformed one, never a script.
    for (const [, payload] of PAYLOADS) {
      let protocol: string;
      try {
        protocol = new URL(payload, "https://shorted.com.au/shorts/BHP").protocol;
      } catch {
        continue;
      }
      if (protocol !== "http:" && protocol !== "https:") {
        expect(safeExternalHref(payload)).toBeUndefined();
      }
    }
    expect(new URL(" javascript:alert(1)", "https://shorted.com.au/").protocol).toBe("javascript:");
    expect(new URL("java\tscript:alert(1)", "https://shorted.com.au/").protocol).toBe("javascript:");
  });
});

describe("safeLinkHref", () => {
  it.each([["/shorts/BHP"], ["/news/some-take?tab=1#section"], ["#ref-1"], ["https://www.asx.com.au/x"]])(
    "keeps %s",
    (href) => {
      expect(safeLinkHref(href)).toBe(href);
    },
  );

  it.each([
    ["//evil.example"],
    ["/\\evil.example"],
    ["/\t/evil.example"],
    ["/\n\\evil.example"],
    ["javascript:alert(1)"],
    [" javascript:alert(1)"],
    ["data:text/html,<b>x</b>"],
    ["shorts/BHP"],
    ["mailto:someone@example.com"],
    [""],
  ])("refuses %p", (href) => {
    expect(safeLinkHref(href)).toBeUndefined();
  });

  it("refuses what a browser reads as protocol-relative", () => {
    for (const href of ["//evil.example", "/\\evil.example", "/\t/evil.example"]) {
      expect(new URL(href, "https://shorted.com.au/news/x").host).toBe("evil.example");
      expect(safeLinkHref(href)).toBeUndefined();
    }
  });
});
