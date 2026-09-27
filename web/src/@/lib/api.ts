import { type Post } from "../interfaces/post";
import fs from "fs";
import matter from "gray-matter";
import path, { join } from "path";

const blogsDirectory = join(process.cwd(), "_blogs");

/**
 * gray-matter's YAML parser turns an unquoted `date: 2026-09-01` into a JS
 * Date, and a Date stringifies as "Tue Sep 01 2026 00:00:00 GMT+0000 (...)",
 * which is not a valid <time dateTime>, sitemap lastmod or schema.org date.
 * Every post so far quotes its dates; this makes the unquoted form safe too.
 */
export function normalizePostData<T extends Record<string, unknown>>(
  data: T,
): T {
  const out: Record<string, unknown> = { ...data };
  for (const key of ["date", "updated"] as const) {
    const value = out[key];
    if (value instanceof Date) {
      out[key] = Number.isNaN(value.getTime())
        ? undefined
        : value.toISOString().slice(0, 10);
    }
  }
  return out as T;
}

export function getPostSlugs() {
  return fs.readdirSync(blogsDirectory);
}

export function getPostBySlug(slug: string): Post | null {
  try {
    const realSlug = slug.replace(/\.md|.mdx$/, "");
    const fullPath = join(blogsDirectory, `${realSlug}.mdx`);
    const fileContents = fs.readFileSync(fullPath, "utf8");
    const { data, content } = matter(fileContents);

    return { ...normalizePostData(data), slug: realSlug, content } as Post;
  } catch {
    return null;
  }
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
        ...(normalizePostData(data) as Omit<Post, "slug" | "content">),
        content,
        slug: fileName.replace(/\.(mdx?)$/i, ""),
      } as Post;
    })
    // Newest first. fs.readdirSync order is not chronological (and differs
    // between local APFS and Vercel's Linux build), so without this the hero
    // post + "More Stories" order is effectively arbitrary and a freshly
    // published post may not surface at the top.
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  return allPosts;
}
