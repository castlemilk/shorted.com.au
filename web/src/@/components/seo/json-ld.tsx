import { serializeJsonLd } from "~/@/lib/seo/json-ld";

/**
 * The one way to put JSON-LD on a page.
 *
 * `data` is serialised with `serializeJsonLd`, which escapes the characters
 * that would let a stored value close the script element and run as markup
 * (lib/seo/json-ld.ts says why). No directive and no hooks, so server and
 * client components can both render it. app/__tests__/json-ld-escaping.test.ts
 * fails a file outside this one that renders an `application/ld+json` script
 * itself.
 */
export function JsonLd({ data }: { data: object }) {
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: serializeJsonLd(data) }}
    />
  );
}
