import Container from "~/@/components/ui/container";
import { HeroPost } from "~/@/components/ui/hero-post";
import { Intro } from "~/@/components/ui/intro";
import { MoreStories } from "~/@/components/ui/more-stories";
import { getAllPosts } from "~/@/lib/api";
import { MDXRemote } from "next-mdx-remote/rsc";
import { type Post } from "~/@/interfaces/post";
import Info from "~/@/components/ui/info";
import RegisterEmail from "~/@/components/ui/register-email";

export const dynamic = 'force-dynamic';

export default async function Index() {
  const allPosts: Post[] = getAllPosts();
  const heroPost = allPosts[0];
  const morePosts = allPosts.slice(1);

  const components = {
    h1: (props: React.HTMLAttributes<HTMLHeadingElement>) => <h1 className="text-4xl font-bold mt-8 mb-4" {...props} />,
    h2: (props: React.HTMLAttributes<HTMLHeadingElement>) => <h2 className="text-3xl font-semibold mt-6 mb-3" {...props} />,
    h3: (props: React.HTMLAttributes<HTMLHeadingElement>) => <h3 className="text-2xl font-medium mt-4 mb-2" {...props} />,
    h4: (props: React.HTMLAttributes<HTMLHeadingElement>) => <h4 className="text-xl font-medium mt-3 mb-2" {...props} />,
    h5: (props: React.HTMLAttributes<HTMLHeadingElement>) => <h5 className="text-lg font-medium mt-2 mb-1" {...props} />,
    h6: (props: React.HTMLAttributes<HTMLHeadingElement>) => <h6 className="text-base font-medium mt-2 mb-1" {...props} />,
    a: (props: React.HTMLAttributes<HTMLAnchorElement>) => <a className="text-blue-500" {...props} />,
    p: (props: React.HTMLAttributes<HTMLParagraphElement>) => <p className="mt-4 mb-4" {...props} />,
    ul: (props: React.HTMLAttributes<HTMLUListElement>) => <ul className="list-disc list-inside mt-2 mb-2" {...props} />,
    ol: (props: React.HTMLAttributes<HTMLOListElement>) => <ol className="list-decimal list-inside mt-2 mb-2" {...props} />,
    li: (props: React.HTMLAttributes<HTMLLIElement>) => <li className="mt-1 mb-1" {...props} />,
    table: (props: React.HTMLAttributes<HTMLTableElement>) => <table className="w-full mt-4 mb-4" {...props} />,
    tr: (props: React.HTMLAttributes<HTMLTableRowElement>) => <tr className="border-b border-gray-200" {...props} />,
    th: (props: React.HTMLAttributes<HTMLTableCellElement>) => <th className="px-4 py-2 text-left" {...props} />,
    td: (props: React.HTMLAttributes<HTMLTableCellElement>) => <td className="px-4 py-2 text-left" {...props} />,
    RegisterEmail: (props: Record<string, unknown>) => <RegisterEmail {...props} />,
    Info: (props: { title: string; children: React.ReactNode }) => <Info {...props} />,
  };

  return (
    <main>
      <Container>
        <Intro />
        {heroPost && (
          <HeroPost
            title={heroPost.title}
            coverImage={heroPost.coverImage}
            date={heroPost.date}
            author={heroPost.author}
            slug={heroPost.slug}
            excerpt={heroPost.excerpt}
          >
            <div className="max-w-2xl mx-auto custom-mdx-content">
              <MDXRemote source={heroPost.content} components={components} />
            </div>
          </HeroPost>
        )}
        {morePosts.length > 0 && <MoreStories posts={morePosts} />}
      </Container>
    </main>
  );
}
