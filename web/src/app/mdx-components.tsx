import type { MDXComponents } from "mdx/types";

export function useMDXComponents(components: MDXComponents): MDXComponents {
  return {
    h1: (props) => <h1 className="text-4xl font-bold mt-8 mb-4" {...props} />,
    h2: (props) => (
      <h2 className="text-3xl font-semibold mt-6 mb-3" {...props} />
    ),
    h3: (props) => <h3 className="text-2xl font-medium mt-4 mb-2" {...props} />,
    h4: (props) => <h4 className="text-xl font-medium mt-3 mb-2" {...props} />,
    h5: (props) => <h5 className="text-lg font-medium mt-2 mb-1" {...props} />,
    h6: (props) => (
      <h6 className="text-base font-medium mt-2 mb-1" {...props} />
    ),
    ...components,
  };
}
