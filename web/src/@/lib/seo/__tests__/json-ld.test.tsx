/// <reference types="jest" />
import { describe, expect, it } from "@jest/globals";
import { renderToStaticMarkup } from "react-dom/server";
import { JsonLd } from "~/@/components/seo/json-ld";
import { serializeJsonLd } from "~/@/lib/seo/json-ld";

/**
 * Security review SEC-07: a JSON-LD script's text is raw HTML, so a stored
 * value carrying `</script>` closed the element when it went through a bare
 * JSON.stringify, and what followed ran as markup.
 */

const BREAKOUT = '</script><img src=x onerror="alert(document.domain)">';

/** The HTML parser's view of a rendered page: what a browser builds. */
function parse(element: JSX.Element): Document {
  return new DOMParser().parseFromString(
    renderToStaticMarkup(<div>{element}</div>),
    "text/html",
  );
}

describe("serializeJsonLd", () => {
  it("leaves no closing script tag, comment opener or CDATA end for the parser to find", () => {
    const out = serializeJsonLd({
      name: BREAKOUT,
      description: "<!-- <script> ]]> -->",
    });

    expect(out).not.toMatch(/<\/script/i);
    expect(out).not.toContain("<");
    expect(out).not.toContain(">");
    expect(out).toContain("\\u003c/script\\u003e\\u003cimg");
  });

  it("parses back to the same value", () => {
    const value = {
      "@context": "https://schema.org",
      "@type": "Corporation",
      name: BREAKOUT,
      "<key>": "a & b",
      separators: "line\u2028paragraph\u2029end",
      nested: [{ text: "x < y > z && w", count: 3, ratio: 1.5, flag: true, none: null }],
      unicode: "Café 😀 — ‘quoted’",
    };

    expect(JSON.parse(serializeJsonLd(value))).toEqual(value);
  });

  it("escapes &, U+2028 and U+2029 too", () => {
    const out = serializeJsonLd({ a: "&", b: "\u2028", c: "\u2029" });

    expect(out).toBe('{"a":"\\u0026","b":"\\u2028","c":"\\u2029"}');
  });

  it("matches JSON.stringify byte for byte when there is nothing to escape", () => {
    const value = {
      "@context": "https://schema.org",
      "@type": "Dataset",
      name: "ASX short positions",
      url: "https://shorted.com.au/shorts/BHP?tab=short-interest",
      keywords: ["short selling", "ASIC"],
      position: 2,
    };

    expect(serializeJsonLd(value)).toBe(JSON.stringify(value));
  });

  it("serialises an array of schemas", () => {
    const value = [{ "@type": "Thing", name: "<b>" }, { "@type": "Thing", name: "c" }];

    expect(JSON.parse(serializeJsonLd(value))).toEqual(value);
  });
});

describe("<JsonLd>", () => {
  it("keeps a breakout payload inside the script element", () => {
    const doc = parse(
      <JsonLd data={{ "@type": "Corporation", name: BREAKOUT, description: "S&P <ASX 200>" }} />,
    );

    const scripts = doc.querySelectorAll("script");
    expect(scripts).toHaveLength(1);
    expect(scripts[0]!.getAttribute("type")).toBe("application/ld+json");
    expect(doc.querySelector("img")).toBeNull();
    expect(JSON.parse(scripts[0]!.textContent ?? "")).toEqual({
      "@type": "Corporation",
      name: BREAKOUT,
      description: "S&P <ASX 200>",
    });
  });
});
