import type { MDXComponents } from "mdx/types";
import Image from "next/image";

const CustomImage = (props: React.ImgHTMLAttributes<HTMLImageElement>) => {
  console.log('CustomImage called with props:', props);
  return (
    <div className="my-8 mx-auto" style={{ width: "80%" }}>
      <Image
        src={props.src || ""}
        alt={props.alt || ""}
        width={800}
        height={600}
        layout="responsive"
        className="rounded-lg"
        {...props}
      />
    </div>
  );
};

export function useMDXComponents(components: MDXComponents): MDXComponents {
  return {
    h1: (props) => <h1 className="text-4xl font-bold mt-8 mb-4" {...props} />,
    h2: (props) => <h2 className="text-3xl font-semibold mt-6 mb-3" {...props} />,
    h3: (props) => <h3 className="text-2xl font-medium mt-4 mb-2" {...props} />,
    h4: (props) => <h4 className="text-xl font-medium mt-3 mb-2" {...props} />,
    h5: (props) => <h5 className="text-lg font-medium mt-2 mb-1" {...props} />,
    h6: (props) => <h6 className="text-base font-medium mt-2 mb-1" {...props} />,
    li: (props) => <li className="list-disc list-inside" {...props} />,
    ol: (props) => <ol className="list-decimal list-inside" {...props} />,
    ul: (props) => <ul className="list-disc list-inside" {...props} />,
    p: (props) => <p className="mt-4 mb-4" {...props} />,
    a: (props) => <a className="text-blue-500 hover:text-blue-600" {...props} />,
    
    img: CustomImage,
    ...components,
  };
}
