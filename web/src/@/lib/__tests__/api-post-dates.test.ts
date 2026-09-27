import matter from "gray-matter";

import { getAllPosts, normalizePostData } from "../api";

describe("normalizePostData", () => {
  it("turns the Date objects YAML makes of unquoted dates into ISO day strings", () => {
    const { data } = matter(
      "---\ndate: 2026-09-01\nupdated: 2026-09-15\n---\nbody",
    );
    expect(data.date).toBeInstanceOf(Date);

    const normalized = normalizePostData(data);
    expect(normalized.date).toBe("2026-09-01");
    expect(normalized.updated).toBe("2026-09-15");
  });

  it("leaves quoted strings and other fields alone", () => {
    const { data } = matter(
      '---\ntitle: "T"\ndate: "2023-10-07T00:00:00.000Z"\n---\nbody',
    );
    expect(normalizePostData(data)).toEqual({
      title: "T",
      date: "2023-10-07T00:00:00.000Z",
    });
  });

  it("drops an invalid date instead of stringifying 'Invalid Date'", () => {
    expect(normalizePostData({ date: new Date("nope") }).date).toBeUndefined();
  });
});

describe("getAllPosts", () => {
  it("returns string dates for every published post, newest first", () => {
    const posts = getAllPosts();
    expect(posts.length).toBeGreaterThan(0);
    for (const post of posts) {
      expect(typeof post.date).toBe("string");
      expect(Number.isNaN(Date.parse(post.date))).toBe(false);
      if (post.updated !== undefined)
        expect(typeof post.updated).toBe("string");
    }
    const times = posts.map((p) => Date.parse(p.date));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });
});
