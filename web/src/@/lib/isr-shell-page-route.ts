/** Resolve a concrete shell URL to the page route used by revalidatePath. */
export function isrShellPageRoute(path: string): string {
  // Each state has a concrete council index URL, but they share one dynamic
  // page. Typing a concrete URL as a page does not match its Next.js page tag.
  // The pattern refreshes those eight indexes without expiring council profiles.
  if (/^\/housing\/(?:act|nsw|nt|qld|sa|tas|vic|wa)\/council$/.test(path)) {
    return "/housing/[state]/council";
  }
  return path;
}
