import { type ReactNode } from "react";
import { safeLinkHref } from "~/@/lib/safe-external-href";

/**
 * Links in a take's MDX body (mdx-take-body.tsx).
 *
 * The body is model-written and stored, and MDX passes a link's destination
 * through untouched, `javascript:` included: `[text](javascript:...)` reaches
 * the `a` component as its href, and a literal `<a href="javascript:...">`
 * skips the components map altogether and renders as written. A take links to
 * our own pages as often as to a source, so both keep a fragment, a
 * root-relative path and an http(s) URL (safeLinkHref), and nothing else.
 */

/** The `a` component: the link, or its text alone when the href is refused. */
export function TakeLink({ href, children }: { href?: string; children?: ReactNode }) {
  const safe = safeLinkHref(href);
  if (!safe) return <>{children}</>;
  return (
    <a
      href={safe}
      target="_blank"
      rel="noopener noreferrer"
      className="text-primary underline decoration-primary/40 underline-offset-4 hover:decoration-primary"
    >
      {children}
    </a>
  );
}

/** The mdast nodes the plugin reads: a JSX element's attributes and children. */
interface MdxNode {
  type: string;
  attributes?: { type: string; name?: string; value?: unknown }[];
  children?: MdxNode[];
}

/**
 * Remark plugin: drops an href that safeLinkHref refuses from every JSX
 * element written into the body (`<a>` and any palette component), so a
 * literal tag gets the check the `a` component applies.
 */
export function remarkSafeJsxHrefs() {
  return (tree: MdxNode) => {
    const visit = (node: MdxNode): void => {
      if (
        (node.type === "mdxJsxFlowElement" || node.type === "mdxJsxTextElement") &&
        node.attributes
      ) {
        node.attributes = node.attributes.filter(
          (attribute) =>
            !(
              attribute.type === "mdxJsxAttribute" &&
              attribute.name?.toLowerCase() === "href" &&
              !(typeof attribute.value === "string" && safeLinkHref(attribute.value))
            ),
        );
      }
      node.children?.forEach(visit);
    };
    visit(tree);
  };
}
