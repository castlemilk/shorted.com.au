/**
 * Every post opens its MDX body with `# <title>`, the same title the
 * article masthead renders as the page h1. The MDX component map turns an
 * H1 into a text-4xl h2, so without this the title appeared twice, the
 * second time larger than the first on phones. Strips exactly one leading
 * ATX H1 and nothing else; a body that starts with prose or an H2 is
 * returned unchanged.
 */
export function stripLeadingHeading(content: string): string {
  return content.replace(/^\s*#[ \t]+[^\r\n]*(?:\r?\n)+/, "");
}
