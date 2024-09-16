import { type MDXRemoteSerializeResult } from 'next-mdx-remote/dist/types';
import { serialize } from 'next-mdx-remote/serialize';

interface MDXOptions {
  // Define any additional MDX options if needed
}

export async function markdownToHtml(content: string): Promise<MDXRemoteSerializeResult> {
  const result = await serialize(content, {
    mdxOptions: {
      // Add any necessary MDX options here
      // For example, you can specify remark plugins if needed
      // remarkPlugins: [],
      // rehypePlugins: [], // Ensure rehypePlugins is empty or contains compatible plugins
      // You can also specify settings for JSX handling
      jsx: true,
    },
  });

  return result;
}