/** @jest-environment node */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { getImplicitTags } from "next/dist/server/lib/implicit-tags";
import isrShellPages from "~/config/isr-shell-pages.json";
import { isrShellPageRoute } from "../isr-shell-page-route";

describe("page-scoped ISR shell invalidation", () => {
  it.each(isrShellPages)("resolves %s to an existing page route", (path) => {
    const route = isrShellPageRoute(path);
    expect(existsSync(join(process.cwd(), "src/app", route, "page.tsx"))).toBe(true);
  });

  it.each([
    ["/", "/page", "/", "/housing/[state]/[suburb]/page", "/housing/nsw/bondi"],
    ["/housing", "/housing/page", "/housing", "/housing/[state]/[suburb]/page", "/housing/nsw/bondi"],
    ["/housing/[state]/council", "/housing/[state]/council/page", "/housing/nsw/council", "/housing/[state]/council/[slug]/page", "/housing/nsw/council/albury"],
  ])("targets %s but not its child pages", async (route, page, pathname, childPage, childPathname) => {
    const targetTag = `_N_T_${route}${route.endsWith("/") ? "" : "/"}page`;
    const target = await getImplicitTags(page, { pathname }, null);
    const child = await getImplicitTags(childPage, { pathname: childPathname }, null);
    expect(target.tags).toContain(targetTag);
    expect(child.tags).not.toContain(targetTag);
  });
});
