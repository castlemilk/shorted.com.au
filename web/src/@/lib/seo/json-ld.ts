/**
 * The text of a `<script type="application/ld+json">` element.
 *
 * A script element's text is raw. The HTML parser ends it at the first
 * `</script` whatever the JSON around it says, and React writes
 * `dangerouslySetInnerHTML` verbatim. `JSON.stringify` leaves `<`, `>` and `&`
 * alone, so a stored value that reaches a schema (a company description, a
 * report narrative, a scraped or model-written field) and carries
 * `</script><img src=x onerror=alert(1)>` closes the element and runs as
 * markup. The CSP allows inline script, so it would not stop it (security
 * review SEC-07).
 *
 * `serializeJsonLd` writes `<`, `>` and `&` as `\u003c`, `\u003e` and
 * `\u0026`, which leaves the HTML parser no `</script`, `<!--` or `]]>` to
 * find, and U+2028 and U+2029 as `\u2028` and `\u2029` for any consumer that
 * reads the text as JavaScript. Those characters occur only inside JSON
 * strings, where a JSON parser reads each escape back as the character it
 * stands for, so `JSON.parse(serializeJsonLd(x))` equals
 * `JSON.parse(JSON.stringify(x))`: a crawler reads the same schema.
 *
 * Render JSON-LD with `<JsonLd data={...} />` (components/seo/json-ld.tsx),
 * which calls this. app/__tests__/json-ld-escaping.test.ts fails a file that
 * renders JSON-LD any other way.
 */

const ESCAPES: Record<string, string> = {
  "<": "\\u003c",
  ">": "\\u003e",
  "&": "\\u0026",
  "\u2028": "\\u2028",
  "\u2029": "\\u2029",
};

const UNSAFE = /[<>&\u2028\u2029]/g;

export function serializeJsonLd(data: object): string {
  // JSON.stringify returns undefined for a value JSON cannot hold (a
  // function). "null" still parses; an empty script would be a syntax error.
  const json = (JSON.stringify(data) as string | undefined) ?? "null";
  return json.replace(UNSAFE, (char) => ESCAPES[char] ?? char);
}
