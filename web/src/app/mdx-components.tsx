import type { MDXComponents } from "mdx/types";
import RegisterEmail from "~/@/components/ui/register-email";

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
    a: (props) => <a className="text-blue-500" {...props} />,
    p: (props) => <p className="mt-4 mb-4" {...props} />,
    ul: (props) => (
      <ul className="list-disc list-inside mt-2 mb-2" {...props} />
    ),
    ol: (props) => (
      <ol className="list-decimal list-inside mt-2 mb-2" {...props} />
    ),
    li: (props) => <li className="mt-1 mb-1" {...props} />,
    table: (props) => <table className="w-full mt-4 mb-4" {...props} />,
    tr: (props) => <tr className="border-b border-gray-200" {...props} />,
    th: (props) => <th className="px-4 py-2 text-left" {...props} />,
    td: (props) => <td className="px-4 py-2 text-left" {...props} />,
    RegisterEmail: (props) => <RegisterEmail {...props} />,
    ...components,
  };
}
