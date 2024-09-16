import Container from "@/components/ui/container";
import { HeroPost } from "@/components/ui/hero-post";
import { Intro } from "@/components/ui/intro";
import { MoreStories } from "@/components/ui/more-stories";
import { getAllPosts } from "@/lib/api";
import { MDXRemote, type MDXRemoteSerializeResult } from "next-mdx-remote/rsc";
import { useMDXComponents } from "@/app/mdx-components";

interface Author {
  name: string;
  picture: string;
}

interface Post {
  title: string;
  coverImage: string;
  date: string;
  author: Author;
  slug: string;
  excerpt: string;
  content: string;
  serializedContent?: MDXRemoteSerializeResult;
}

// Remove the components object, as we'll use the global MDX components

export default async function Index() {
  const allPosts: Post[] = getAllPosts();
  const heroPost = allPosts[0];
  const morePosts = allPosts.slice(1);
  const components = useMDXComponents({});

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
            <MDXRemote source={heroPost.content} components={components} />
          </HeroPost>
        )}
        {morePosts.length > 0 && <MoreStories posts={morePosts} />}
      </Container>
    </main>
  );
}
