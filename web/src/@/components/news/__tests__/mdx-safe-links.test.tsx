import { render, screen } from "@testing-library/react";
import { remarkSafeJsxHrefs, TakeLink } from "../mdx-safe-links";

/**
 * A take's MDX body is model-written and stored. MDX hands a markdown link's
 * destination to the `a` component untouched, and renders a literal
 * `<a href="...">` as written, `javascript:` included (security review SEC-07).
 */

describe("TakeLink, a take's `a` component", () => {
  it.each([["/shorts/BHP"], ["#ref-2"], ["https://www.asx.com.au/markets/company/BHP"]])(
    "links %s",
    (href) => {
      render(<TakeLink href={href}>the link</TakeLink>);
      expect(screen.getByRole("link", { name: "the link" })).toHaveAttribute("href", href);
    },
  );

  it.each([["javascript:alert(document.cookie)"], [" javascript:alert(1)"], ["data:text/html,<b>x</b>"], ["//evil.example"]])(
    "renders the text alone for %p",
    (href) => {
      const { container } = render(<TakeLink href={href}>the link</TakeLink>);
      expect(screen.queryByRole("link")).not.toBeInTheDocument();
      expect(container.querySelector("a")).toBeNull();
      expect(container).toHaveTextContent("the link");
    },
  );
});

/** A paragraph holding a literal JSX element with these attributes. */
function tree(attributes: { type: string; name?: string; value?: unknown }[]) {
  return {
    type: "root",
    children: [
      {
        type: "paragraph",
        children: [{ type: "mdxJsxTextElement", name: "a", attributes, children: [] }],
      },
      { type: "mdxJsxFlowElement", name: "Figure", attributes: [{ type: "mdxJsxAttribute", name: "src", value: "/x.png" }], children: [] },
    ],
  };
}

const jsxAttributes = (root: ReturnType<typeof tree>) =>
  (root.children[0]!.children![0] as { attributes: unknown[] }).attributes;

describe("remarkSafeJsxHrefs", () => {
  it("drops a javascript: href from a literal <a>, and keeps its other attributes", () => {
    const root = tree([
      { type: "mdxJsxAttribute", name: "href", value: "javascript:alert(1)" },
      { type: "mdxJsxAttribute", name: "title", value: "Source" },
    ]);

    remarkSafeJsxHrefs()(root);

    expect(jsxAttributes(root)).toEqual([{ type: "mdxJsxAttribute", name: "title", value: "Source" }]);
  });

  it.each([["HREF"], ["href"]])("drops a refused %s however it is cased", (name) => {
    const root = tree([{ type: "mdxJsxAttribute", name, value: "data:text/html,<b>x</b>" }]);

    remarkSafeJsxHrefs()(root);

    expect(jsxAttributes(root)).toEqual([]);
  });

  it("drops an href that is not a plain string", () => {
    const root = tree([
      { type: "mdxJsxAttribute", name: "href", value: { type: "mdxJsxAttributeValueExpression", value: "x" } },
    ]);

    remarkSafeJsxHrefs()(root);

    expect(jsxAttributes(root)).toEqual([]);
  });

  it("keeps an http(s), root-relative or fragment href, and leaves other elements alone", () => {
    for (const value of ["https://www.asx.com.au/x", "/shorts/BHP", "#ref-1"]) {
      const root = tree([{ type: "mdxJsxAttribute", name: "href", value }]);

      remarkSafeJsxHrefs()(root);

      expect(jsxAttributes(root)).toEqual([{ type: "mdxJsxAttribute", name: "href", value }]);
      expect(root.children[1]).toEqual(
        expect.objectContaining({ attributes: [{ type: "mdxJsxAttribute", name: "src", value: "/x.png" }] }),
      );
    }
  });
});
