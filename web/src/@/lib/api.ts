import { type Post } from "../interfaces/post";
import fs from "fs";
import matter from "gray-matter";
import path, { join } from "path";

const blogsDirectory = join(process.cwd(), "_blogs");

export function getPostSlugs() {
  return fs.readdirSync(blogsDirectory);
}

export function getPostBySlug(slug: string) {
  const realSlug = slug.replace(/\.md|.mdx$/, "");
  const fullPath = join(blogsDirectory, `${realSlug}.mdx`);
  const fileContents = fs.readFileSync(fullPath, "utf8");
  const { data, content } = matter(fileContents);

  return { ...data, slug: realSlug, content } as Post;
}

export function getAllPosts(): Post[] {
  const fileNames = fs.readdirSync(blogsDirectory);
  const allPosts: Post[] = fileNames
    .filter((fileName) => /\.(md|mdx)$/i.test(fileName)) // Explicitly match .md and .mdx files
    .map((fileName) => {
      const fullPath = path.join(blogsDirectory, fileName);
      const fileContents = fs.readFileSync(fullPath, "utf8");

      const { data, content } = matter(fileContents);

      return {
        ...(data as Omit<Post, "slug" | "content">),
        content,
        slug: fileName.replace(/\.(mdx?)$/i, ""),
      } as Post;
    });

  return allPosts;
}
